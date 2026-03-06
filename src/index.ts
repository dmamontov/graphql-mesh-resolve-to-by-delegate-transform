import deepClean from 'clean-deep';
import deepMerge from 'deepmerge';
import { dset } from 'dset';
import {
    getNamedType,
    isAbstractType,
    isInterfaceType,
    isObjectType,
    Kind,
    type GraphQLFieldConfig,
    type GraphQLObjectType,
    type GraphQLSchema,
    type SelectionSetNode,
} from 'graphql';
import lodashGet from 'lodash.get';
import lodashSortBy from 'lodash.sortby';
import toPath from 'lodash.topath';
import lodashUniqBy from 'lodash.uniqby';
import { mergeSelectionSets } from '@graphql-codegen/visitor-plugin-common';
import { stringInterpolator } from '@graphql-mesh/string-interpolation';
import { type StitchingInfo, type Transform } from '@graphql-tools/delegate';
import { mergeResolvers } from '@graphql-tools/merge';
import { addResolversToSchema } from '@graphql-tools/schema';
import { MapperKind, mapSchema, parseSelectionSet, type IResolvers } from '@graphql-tools/utils';
import { addStitchingInfo, completeStitchingInfo } from './stitchingInfo';
import {
    type ResolveToByCondition,
    type ResolveToByConditionResolver,
    type ResolveToByConditionResolverArgs,
} from './types';
import {
    deeplySetArgs,
    getTypeByPath,
    NotFoundError,
    parseLiteral,
    stringifySelectionSet,
} from './utils';
import { withFilter } from './withFilter';

export default class ResolveToByDelegateTransform implements Transform {
    public noWrap: boolean = true;

    transformSchema(originalWrappingSchema: GraphQLSchema) {
        if (!Object.keys(originalWrappingSchema.extensions).includes('stitchingInfo')) {
            return originalWrappingSchema;
        }

        const toResolve: ResolveToByCondition[] = [];

        let newSchema = mapSchema(originalWrappingSchema, {
            [MapperKind.COMPOSITE_FIELD]: (
                fieldConfig: GraphQLFieldConfig<any, any>,
                fieldName: string,
                typeName: string,
            ) => {
                if (
                    !fieldConfig.astNode?.directives ||
                    (fieldConfig.extensions &&
                        Object.keys(fieldConfig.extensions).includes('conditionResolvers'))
                ) {
                    return fieldConfig;
                }

                const directives = fieldConfig.astNode.directives.filter(
                    node => node.name.value === 'resolveToBy',
                );
                if (!directives.length) {
                    return fieldConfig;
                }

                const resolvers: ResolveToByConditionResolver[] = [];
                for (const directive of directives) {
                    const args: Record<string, any> = {};
                    for (const arg of directive.arguments) {
                        args[arg.name.value] = parseLiteral(arg.value);
                    }

                    resolvers.push({
                        args: {
                            ...args,
                            targetTypeName: typeName,
                            targetFieldName: fieldName,
                            targetFieldNodeType: fieldConfig.astNode.type.kind,
                        } as ResolveToByConditionResolverArgs,
                        options: {},
                    });
                }

                toResolve.push({
                    typeName,
                    fieldName,
                    fieldNodeType: fieldConfig.astNode.type.kind,
                    resolvers,
                });

                return {
                    ...fieldConfig,
                    extensions: {
                        ...fieldConfig.extensions,
                        conditionResolvers: resolvers,
                    },
                };
            },
        });

        if (toResolve.length > 0) {
            const resolvers = this.buildResolvers(toResolve, newSchema.extensions);
            if (!resolvers) {
                return originalWrappingSchema;
            }

            newSchema = addResolversToSchema({
                schema: newSchema,
                resolvers,
                inheritResolversFromInterfaces: false,
                updateResolversInPlace: true,
            });

            const stitchingInfo = completeStitchingInfo(
                newSchema.extensions.stitchingInfo as StitchingInfo,
                resolvers,
                newSchema,
            );

            addStitchingInfo(newSchema, stitchingInfo);
        }

        return newSchema;
    }

    private buildResolvers(
        toResolve: ResolveToByCondition[],
        extensions: Record<string, any>,
    ): IResolvers | undefined {
        const resolvers: IResolvers[] = [];

        for (const resolveArgs of toResolve) {
            let selectionsSet: SelectionSetNode | undefined;
            for (const resolver of resolveArgs.resolvers) {
                if (!resolver.args?.requiredSelectionSet && !resolver.args?.keyField) {
                    continue;
                }

                if (selectionsSet) {
                    selectionsSet = mergeSelectionSets(
                        selectionsSet,
                        parseSelectionSet(
                            resolver.args.requiredSelectionSet || `{ ${resolver.args.keyField} }`,
                            { noLocation: true },
                        ),
                    );
                } else {
                    selectionsSet = parseSelectionSet(
                        resolver.args.requiredSelectionSet || `{ ${resolver.args.keyField} }`,
                        { noLocation: true },
                    );
                }
            }

            resolvers.push({
                [resolveArgs.typeName]: {
                    [resolveArgs.fieldName]: {
                        selectionSet: stringifySelectionSet(selectionsSet),
                        subscribe: async (root, args, context, info) => {
                            for (const resolver of resolveArgs.resolvers) {
                                if (resolver.args.condition) {
                                    const conditionFn = new Function(
                                        'root',
                                        'args',
                                        'context',
                                        'env',
                                        'return ' + resolver.args.condition,
                                    );

                                    if (!conditionFn(root, args, context, process.env)) {
                                        continue;
                                    }
                                }

                                return withFilter(
                                    (root, args, context, info) => {
                                        const resolverData = {
                                            root,
                                            args,
                                            context,
                                            info,
                                            env: process.env,
                                        };
                                        const topic = stringInterpolator.parse(
                                            resolver.args.pubsubTopic,
                                            resolverData,
                                        );
                                        return context.pubsub.asyncIterator(
                                            topic,
                                        ) as AsyncIterableIterator<any>;
                                    },
                                    (root, args, context, info) => {
                                        return resolver.args.filterBy
                                            ? new Function(`return ${resolver.args.filterBy}`)()
                                            : true;
                                    },
                                )(root, args, context, info);
                            }

                            return undefined;
                        },
                        resolve: async (root: any, args: any, context: any, info: any) => {
                            let rootPromise: Promise<any> | undefined;
                            for (const resolver of resolveArgs.resolvers) {
                                if (!context[resolver.args.sourceName]) {
                                    throw new NotFoundError(
                                        `No source found named "${resolver.args.sourceName}"`,
                                        [resolveArgs.fieldName],
                                    );
                                }

                                if (
                                    !context[resolver.args.sourceName][resolver.args.sourceTypeName]
                                ) {
                                    throw new NotFoundError(
                                        `No root type found named "${resolver.args.sourceTypeName}" exists in the source ${resolver.args.sourceName}\n` +
                                            `It should be one of the following; ${Object.keys(
                                                context[resolver.args.sourceName],
                                            ).join(',')})}}`,
                                        [resolveArgs.fieldName],
                                    );
                                }

                                if (
                                    !context[resolver.args.sourceName][
                                        resolver.args.sourceTypeName
                                    ][resolver.args.sourceFieldName]
                                ) {
                                    throw new NotFoundError(
                                        `No field named "${resolver.args.sourceFieldName}" exists in the type ${resolver.args.sourceTypeName} from the source ${resolver.args.sourceName}`,
                                        [resolveArgs.fieldName],
                                    );
                                }

                                if (
                                    Object.keys(args || {}).length > 0 &&
                                    Object.keys(context.rootArgs || {}).length === 0
                                ) {
                                    context.rootArgs = args;
                                }

                                if (resolver.args.condition) {
                                    const conditionFn = new Function(
                                        'root',
                                        'args',
                                        'context',
                                        'env',
                                        'return ' + resolver.args.condition,
                                    );

                                    if (!conditionFn(root, args, context, process.env)) {
                                        continue;
                                    }
                                }

                                resolver.options.valuesFromResults = this.generateValuesFromResults(
                                    resolver,
                                    resolveArgs,
                                    root,
                                    args,
                                    context,
                                );

                                if (resolver.args.pubsubTopic) {
                                    if (resolver.options.valuesFromResults) {
                                        return resolver.options.valuesFromResults(root);
                                    }

                                    return root;
                                }

                                if (!resolver.options.selectionSet) {
                                    resolver.options.selectionSet =
                                        this.generateSelectionSetFactory(
                                            info.schema,
                                            resolver,
                                            extensions,
                                        );
                                }

                                const resolverData = {
                                    root,
                                    args,
                                    context,
                                    info,
                                    env: process.env,
                                };
                                const targetArgs: any = {};
                                let options: any = {};
                                const sourceArgs: any = resolver.args.sourceArgs || context.rootArgs

                                if (resolver.args.keysArg) {
                                    for (const argPath in resolver.args.additionalArgs || {}) {
                                        dset(
                                            targetArgs,
                                            argPath,
                                            stringInterpolator.parse(
                                                resolver.args.additionalArgs[argPath],
                                                resolverData,
                                            ),
                                        );
                                    }

                                    options = {
                                        ...resolver.options,
                                        root,
                                        context,
                                        info,
                                        argsFromKeys: (keys: string[]) => {
                                            const args: any = {};
                                            dset(args, resolver.args.keysArg, keys);
                                            Object.assign(args, targetArgs);
                                            return args;
                                        },
                                        key: lodashGet(root, resolver.args.keyField),
                                    };
                                } else {
                                    deeplySetArgs(
                                        resolverData,
                                        { targetArgs },
                                        'targetArgs',
                                        sourceArgs,
                                    );

                                    options = {
                                        ...resolver.options,
                                        root,
                                        args: targetArgs,
                                        context,
                                        info,
                                    };
                                }

                                const delegate =
                                    context[resolver.args.sourceName][resolver.args.sourceTypeName][
                                        resolver.args.sourceFieldName
                                    ];

                                if (resolver.args.asRoot) {
                                    rootPromise = delegate(options);
                                } else if (rootPromise instanceof Promise) {
                                    return rootPromise.then(newRoot => {
                                        if (!newRoot || newRoot instanceof Error) {
                                            return newRoot;
                                        }

                                        let omptimizedRoot =
                                            Array.isArray(newRoot) && newRoot.length > 0
                                                ? newRoot[0]
                                                : newRoot;

                                        if (!Array.isArray(omptimizedRoot) && root) {
                                            omptimizedRoot = Object.assign(root, omptimizedRoot);
                                        }

                                        if (resolver.args.keysArg) {
                                            return delegate({
                                                ...options,
                                                root: omptimizedRoot,
                                            });
                                        }

                                        deeplySetArgs(
                                            { ...resolverData, root: omptimizedRoot },
                                            { targetArgs },
                                            'targetArgs',
                                            sourceArgs,
                                        );

                                        return delegate({
                                            ...options,
                                            root: omptimizedRoot,
                                            args: targetArgs,
                                        });
                                    });
                                } else {
                                    return delegate(options).then((entity: any) =>
                                        entity?.__is_deleted ? null : entity,
                                    );
                                }
                            }

                            return resolveArgs.fieldNodeType === Kind.LIST_TYPE ? [] : undefined;
                        },
                    },
                },
            });
        }

        return resolvers.length > 0 ? mergeResolvers(resolvers) : undefined;
    }

    private generateValuesFromResults(
        resolver: ResolveToByConditionResolver,
        resolveArgs: ResolveToByCondition,
        root: any,
        args: any,
        context: any,
    ) {
        const valuesFromResults = (result: any, keys: any): any => {
            if (!result || result instanceof Error) {
                return result;
            }

            if (resolver.args.result) {
                const path = toPath(resolver.args.result);
                if (Number.isNaN(Number(path[0])) && Array.isArray(result)) {
                    result = result.map(valuesFromResults);
                } else {
                    result = lodashGet(result, resolver.args.result);
                }
            }

            if (resolver.args.filterBy) {
                const filterByFn = new Function(
                    'result',
                    'root',
                    'args',
                    'context',
                    'env',
                    'return ' + resolver.args.filterBy,
                );

                if (Array.isArray(result)) {
                    result = result.filter(data =>
                        filterByFn(data, root, args, context, process.env),
                    );
                } else if (!filterByFn(result, root, args, context, process.env)) {
                    return resolveArgs.fieldNodeType === Kind.LIST_TYPE ? [] : undefined;
                }
            }

            if (Array.isArray(result)) {
                if (resolver.args.orderByPath) {
                    result = lodashSortBy(
                        result,
                        (element: any) => lodashGet(element, resolver.args.orderByPath),
                        [resolver.args.orderByDirection],
                    );
                }

                if (resolver.args.uniqueByPath) {
                    result = lodashUniqBy(result, (element: any) =>
                        lodashGet(element, resolver.args.uniqueByPath),
                    );
                }

                if (resolver.args.mergeBy) {
                    const mergedResult: Record<string, any> = {};
                    for (const element of result) {
                        const key = lodashGet(element, resolver.args.mergeBy)?.toString();
                        if (key) {
                            mergedResult[key] = Object.keys(mergedResult).includes(key)
                                ? deepMerge(mergedResult[key], deepClean(element))
                                : element;
                        }
                    }

                    result = Object.values(mergedResult);
                }
            }

            if (resolver.args.hoistPath) {
                result = lodashGet(result, resolver.args.hoistPath);
            }

            if (!Array.isArray(result) && resolveArgs.fieldNodeType === Kind.LIST_TYPE) {
                result = [result];
            } else if (Array.isArray(result) && Array.isArray(keys) && resolver.args.keyField) {
                result = keys.map(
                    key =>
                        result.find(
                            (relation: any) =>
                                String(relation[resolver.args.keyField]) === String(key),
                        ) || { [resolver.args.keyField]: key, __is_deleted: true },
                );
            } else if (Array.isArray(result) && resolveArgs.fieldNodeType !== Kind.LIST_TYPE) {
                result = result.length > 0 ? result[0] : undefined;
            }

            return result;
        };

        return valuesFromResults;
    }

    private generateSelectionSetFactory(
        schema: GraphQLSchema,
        resolver: ResolveToByConditionResolver,
        extensions: Record<string, any>,
    ) {
        let sourceSelectionSet: SelectionSetNode | undefined;
        if (resolver.args.sourceSelectionSet) {
            sourceSelectionSet = parseSelectionSet(resolver.args.sourceSelectionSet);
        }

        const sourceType = schema.getType(resolver.args.sourceTypeName) as GraphQLObjectType;
        const sourceTypeFields = sourceType.getFields();
        const sourceField = sourceTypeFields[resolver.args.sourceFieldName];
        const sourceFieldNamedType = getNamedType(sourceField.type);
        const abstractSourceTypeName = sourceFieldNamedType.name;

        let abstractResultTypeName: string;
        if (resolver.args.resultType) {
            abstractResultTypeName = resolver.args.resultType;
        } else {
            const targetType = schema.getType(resolver.args.targetTypeName) as GraphQLObjectType;
            const targetTypeFields = targetType.getFields();
            const targetField = targetTypeFields[resolver.args.targetFieldName];
            const targetFieldType = getNamedType(targetField.type);

            abstractResultTypeName = targetFieldType.name;
        }

        const stitchSelectionSet = (subtree: SelectionSetNode): SelectionSetNode => {
            if (
                !extensions.stitchingInfo?.fieldNodesByField ||
                (!Object.keys(extensions.stitchingInfo.fieldNodesByField).includes(
                    abstractSourceTypeName,
                ) &&
                    !Object.keys(extensions.stitchingInfo.fieldNodesByField).includes(
                        abstractResultTypeName,
                    ))
            ) {
                return subtree;
            }

            const typeName = Object.keys(extensions.stitchingInfo.fieldNodesByField).includes(
                abstractSourceTypeName,
            )
                ? abstractSourceTypeName
                : abstractResultTypeName;
            const stitchInfo = extensions.stitchingInfo?.fieldNodesByField[typeName];

            if (!stitchInfo) {
                return subtree;
            }

            let newSubTree = subtree;
            for (const selection of subtree.selections) {
                if (
                    (selection as any)?.name?.value &&
                    Object.keys(stitchInfo).includes((selection as any).name.value)
                ) {
                    if (Array.isArray(stitchInfo[(selection as any).name.value])) {
                        newSubTree.selections = newSubTree.selections.concat(
                            stitchInfo[(selection as any).name.value],
                        );
                    } else {
                        (newSubTree.selections as any[]).push(
                            stitchInfo[(selection as any).name.value],
                        );
                    }
                }
            }

            return newSubTree;
        };

        if (resolver.args.result) {
            const resultPath = toPath(resolver.args.result);

            const resultFieldType = getTypeByPath(sourceField.type, resultPath);

            if (isAbstractType(resultFieldType)) {
                if (abstractResultTypeName !== resultFieldType.name) {
                    const abstractResultType = schema.getType(abstractResultTypeName);
                    if (
                        (isInterfaceType(abstractResultType) || isObjectType(abstractResultType)) &&
                        !schema.isSubType(resultFieldType, abstractResultType)
                    ) {
                        throw new Error(
                            `${resolver.args.sourceTypeName}.${
                                resolver.args.sourceFieldName
                            }.${resultPath.join('.')} doesn't implement ${abstractResultTypeName}.}`,
                        );
                    }
                }
            }

            return (subtree: SelectionSetNode) => {
                subtree = stitchSelectionSet(subtree);

                let finalSelectionSet = subtree;
                if (sourceSelectionSet) {
                    finalSelectionSet = resolver.args.asRoot
                        ? sourceSelectionSet
                        : mergeSelectionSets(sourceSelectionSet, finalSelectionSet);
                }

                let isLastResult = true;
                const resultPathReversed = [...resultPath].reverse();
                for (const pathElem of resultPathReversed) {
                    if (Number.isNaN(parseInt(pathElem))) {
                        if (
                            isLastResult &&
                            abstractResultTypeName &&
                            isAbstractType(resultFieldType) &&
                            abstractResultTypeName !== resultFieldType.name
                        ) {
                            finalSelectionSet = {
                                kind: Kind.SELECTION_SET,
                                selections: [
                                    {
                                        kind: Kind.INLINE_FRAGMENT,
                                        typeCondition: {
                                            kind: Kind.NAMED_TYPE,
                                            name: {
                                                kind: Kind.NAME,
                                                value: abstractResultTypeName,
                                            },
                                        },
                                        selectionSet: finalSelectionSet,
                                    },
                                ],
                            };
                        }
                        finalSelectionSet = {
                            kind: Kind.SELECTION_SET,
                            selections: [
                                {
                                    kind: Kind.FIELD,
                                    name: {
                                        kind: Kind.NAME,
                                        value: pathElem,
                                    },
                                    selectionSet: finalSelectionSet,
                                },
                            ],
                        };
                        isLastResult = false;
                    }
                }
                return finalSelectionSet;
            };
        }

        return (subtree: SelectionSetNode) => {
            subtree = stitchSelectionSet(subtree);
            if (sourceSelectionSet) {
                return resolver.args.asRoot
                    ? sourceSelectionSet
                    : mergeSelectionSets(sourceSelectionSet, subtree);
            }

            return subtree;
        };
    }
}
