/**
 * Server management API hooks.
 * Hand-written to match the pattern of the orval-generated api.ts.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  MutationFunction,
  QueryFunction,
  QueryKey,
  UseMutationOptions,
  UseMutationResult,
  UseQueryOptions,
  UseQueryResult,
} from '@tanstack/react-query';
import type {
  CreateServerBody,
  ErrorResponse,
  ServerConfig,
  TestConnectionResponse,
  UpdateServerBody,
} from './api.schemas';
import { customFetch } from '../custom-fetch';
import type { ErrorType, BodyType } from '../custom-fetch';

// ── List servers ──────────────────────────────────────────────────────────────

export const getListServersQueryKey = () => ['listServers'] as const;

export const listServers = async (options?: Parameters<typeof customFetch>[1]): Promise<ServerConfig[]> =>
  customFetch<ServerConfig[]>('/api/servers', { ...options, method: 'GET' });

export function useListServers<TData = ServerConfig[], TError = ErrorType<ErrorResponse>>(
  options?: { query?: UseQueryOptions<ServerConfig[], TError, TData>; request?: Parameters<typeof customFetch>[1] }
): UseQueryResult<TData, TError> & { queryKey: QueryKey } {
  const { query: queryOptions, request: requestOptions } = options ?? {};
  const queryKey = queryOptions?.queryKey ?? getListServersQueryKey();
  const queryFn: QueryFunction<ServerConfig[]> = ({ signal }) => listServers({ signal, ...requestOptions });
  const q = useQuery({ queryKey, queryFn, ...queryOptions }) as UseQueryResult<TData, TError> & { queryKey: QueryKey };
  q.queryKey = queryKey;
  return q;
}

// ── Create server ─────────────────────────────────────────────────────────────

export const createServer = async (data: BodyType<CreateServerBody>, options?: Parameters<typeof customFetch>[1]): Promise<ServerConfig> =>
  customFetch<ServerConfig>('/api/servers', { ...options, method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', ...(options?.headers as object) } });

export const useCreateServer = <TError = ErrorType<ErrorResponse>, TContext = unknown>(
  options?: { mutation?: UseMutationOptions<ServerConfig, TError, { data: BodyType<CreateServerBody> }, TContext>; request?: Parameters<typeof customFetch>[1] }
): UseMutationResult<ServerConfig, TError, { data: BodyType<CreateServerBody> }, TContext> => {
  const { mutation: mutationOptions, request: requestOptions } = options ?? {};
  const mutationFn: MutationFunction<ServerConfig, { data: BodyType<CreateServerBody> }> = ({ data }) =>
    createServer(data, requestOptions);
  return useMutation({ mutationFn, ...mutationOptions });
};

// ── Update server ─────────────────────────────────────────────────────────────

export const updateServer = async (id: number, data: BodyType<UpdateServerBody>, options?: Parameters<typeof customFetch>[1]): Promise<ServerConfig> =>
  customFetch<ServerConfig>(`/api/servers/${id}`, { ...options, method: 'PATCH', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', ...(options?.headers as object) } });

export const useUpdateServer = <TError = ErrorType<ErrorResponse>, TContext = unknown>(
  options?: { mutation?: UseMutationOptions<ServerConfig, TError, { id: number; data: BodyType<UpdateServerBody> }, TContext>; request?: Parameters<typeof customFetch>[1] }
): UseMutationResult<ServerConfig, TError, { id: number; data: BodyType<UpdateServerBody> }, TContext> => {
  const { mutation: mutationOptions, request: requestOptions } = options ?? {};
  const mutationFn: MutationFunction<ServerConfig, { id: number; data: BodyType<UpdateServerBody> }> = ({ id, data }) =>
    updateServer(id, data, requestOptions);
  return useMutation({ mutationFn, ...mutationOptions });
};

// ── Delete server ─────────────────────────────────────────────────────────────

export const deleteServer = async (id: number, options?: Parameters<typeof customFetch>[1]): Promise<void> =>
  customFetch<void>(`/api/servers/${id}`, { ...options, method: 'DELETE' });

export const useDeleteServer = <TError = ErrorType<ErrorResponse>, TContext = unknown>(
  options?: { mutation?: UseMutationOptions<void, TError, { id: number }, TContext>; request?: Parameters<typeof customFetch>[1] }
): UseMutationResult<void, TError, { id: number }, TContext> => {
  const { mutation: mutationOptions, request: requestOptions } = options ?? {};
  const mutationFn: MutationFunction<void, { id: number }> = ({ id }) => deleteServer(id, requestOptions);
  return useMutation({ mutationFn, ...mutationOptions });
};

// ── Test connection ───────────────────────────────────────────────────────────

export const testServerConnection = async (id: number, options?: Parameters<typeof customFetch>[1]): Promise<TestConnectionResponse> =>
  customFetch<TestConnectionResponse>(`/api/servers/${id}/test`, { ...options, method: 'POST' });

export const useTestServerConnection = <TError = ErrorType<ErrorResponse>, TContext = unknown>(
  options?: { mutation?: UseMutationOptions<TestConnectionResponse, TError, { id: number }, TContext>; request?: Parameters<typeof customFetch>[1] }
): UseMutationResult<TestConnectionResponse, TError, { id: number }, TContext> => {
  const { mutation: mutationOptions, request: requestOptions } = options ?? {};
  const mutationFn: MutationFunction<TestConnectionResponse, { id: number }> = ({ id }) =>
    testServerConnection(id, requestOptions);
  return useMutation({ mutationFn, ...mutationOptions });
};
