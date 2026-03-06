import { dset } from 'dset';
import {
    getNamedType,
    GraphQLError,
    Kind,
    OperationTypeNode,
    print,
    type ASTNode,
    type ConstObjectValueNode,
    type ConstValueNode,
    type GraphQLNamedType,
    type GraphQLType,
    type SelectionSetNode,
} from 'graphql';
import { stringInterpolator } from '@graphql-mesh/string-interpolation';

export const deeplySetArgs = (resolverData: any, args: object, path: string, value: any) => {
    if (typeof value === 'string') {
        dset(args, path, stringInterpolator.parse(value.toString(), resolverData));
    } else {
        for (const key in value) {
            deeplySetArgs(resolverData, args, `${path}.${key}`, value[key]);
        }
    }
};

export const getTypeByPath = (type: GraphQLType, path: string[]): GraphQLNamedType => {
    if ('ofType' in type) {
        return getTypeByPath(getNamedType(type), path);
    }
    if (path.length === 0) {
        return getNamedType(type);
    }
    if (!('getFields' in type)) {
        throw new Error(`${type.name} cannot have a path ${path.join('.')}`);
    }
    const fieldMap = type.getFields();
    const currentFieldName = path[0];
    // Might be an index of an array
    if (!Number.isNaN(parseInt(currentFieldName))) {
        return getTypeByPath(type, path.slice(1));
    }
    const field = fieldMap[currentFieldName];
    if (!field?.type) {
        throw new Error(`${type.name}.${currentFieldName} is not a valid field.`);
    }
    return getTypeByPath(field.type, path.slice(1));
};

export const stringifySelectionSet = (selectionSet?: SelectionSetNode): string | undefined => {
    if (!selectionSet) {
        return undefined;
    }

    const query = {
        kind: Kind.DOCUMENT,
        definitions: [
            {
                kind: Kind.OPERATION_DEFINITION,
                operation: OperationTypeNode.QUERY,
                selectionSet,
            },
        ],
    };

    return print(query as ASTNode)
        .replace('query', '')
        .trim();
};

export const parseLiteral = (ast: ConstValueNode): any => {
    switch (ast.kind) {
        case Kind.STRING:
        case Kind.BOOLEAN: {
            return ast.value;
        }
        case Kind.INT:
        case Kind.FLOAT: {
            return parseFloat(ast.value);
        }
        case Kind.OBJECT: {
            return parseObject(ast);
        }
        case Kind.LIST: {
            return ast.values.map(n => parseLiteral(n));
        }
        case Kind.NULL: {
            return null;
        }
    }
};

const parseObject = (ast: ConstObjectValueNode): any => {
    const value = Object.create(null);
    ast.fields.forEach(field => {
        // eslint-disable-next-line no-use-before-define
        value[field.name.value] = parseLiteral(field.value);
    });

    return value;
};

export class NotFoundError extends GraphQLError {
    constructor(message: string, path: string[]) {
        super(message, {
            path,
            extensions: {
                code: 'NOT_FOUND',
            },
        });
    }
}
