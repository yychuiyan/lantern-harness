import { BUSINESS_MAP_API, BusinessMapApiError } from './business-map';

export interface BusinessLoginConfig {
  revision: string;
  mode: 'none' | 'password' | 'sso' | 'manual';
  username: string;
  loginUrl: string;
  endpoint: string;
  bodyTemplate: string;
  tokenPath: string;
  tokenStorageKey: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
}
export interface BusinessLoginStatus {
  config: BusinessLoginConfig;
  hasPassword: boolean;
  stateReady: boolean;
  status: 'idle' | 'opening' | 'awaiting_login' | 'ready';
  message: string;
  savedAt: string;
}
export const DEFAULT_LOGIN_CONFIG: BusinessLoginConfig = {
  revision: '',
  mode: 'none',
  username: '',
  loginUrl: '',
  endpoint: '',
  bodyTemplate: '{"username":"{{username}}","password":"{{password}}"}',
  tokenPath: '',
  tokenStorageKey: 'token',
  usernameSelector: '',
  passwordSelector: '',
  submitSelector: '',
};
export async function businessLoginRequest(
  systemId: string,
  action = '',
  method = 'GET',
  body?: unknown,
): Promise<BusinessLoginStatus> {
  const response = await fetch(
    `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/login${action ? '/' + action : ''}`,
    {
      method,
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    },
  );
  const data = await response.json();
  if (response.status === 405 || data.code === 'revision_conflict' || (response.ok && !data.config))
    throw new BusinessMapApiError(
      '当前 Lantern 后端尚未加载登录配置接口，请重启 Lantern 服务后再试',
      response.status,
      'login_api_unavailable',
    );
  if (!response.ok)
    throw new BusinessMapApiError(data.error || '登录操作失败', response.status, data.code);
  return data;
}
