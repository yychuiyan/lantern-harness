import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getUserConfigDir } from '../../cli/user-config.mjs';

export const businessLoginRoot = () => path.join(getUserConfigDir(), 'business-map', 'auth');

export function businessLoginDir(root, systemId) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(systemId)) throw new Error('业务系统编号无效');
  const spaceKey = crypto.createHash('sha256').update(path.resolve(root)).digest('hex');
  return path.join(businessLoginRoot(), spaceKey, systemId);
}

export function businessLoginStatePath(root, systemId) {
  return path.join(businessLoginDir(root, systemId), '.auth', 'admin.json');
}

export function businessLoginRequired(root, systemId) {
  try {
    return (
      JSON.parse(
        fs.readFileSync(path.join(businessLoginDir(root, systemId), 'config.json'), 'utf8'),
      ).mode !== 'none'
    );
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error('登录配置不可读，请在系统设置重新保存');
  }
}

export function resolveBusinessLoginState(root, system) {
  const dir = businessLoginDir(root, system.id);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('登录配置不可读，请在系统设置重新保存');
  }
  if (config) {
    if (config.mode === 'none') return '';
    const state = businessLoginStatePath(root, system.id);
    return fs.existsSync(state) ? state : '';
  }
  return system.loginState ? path.resolve(system.sourceDir || root, system.loginState) : '';
}

export async function hasLoginChallenge(page) {
  return Boolean(
    await page
      .locator(
        [
          'input[type="password"]:visible',
          'input[autocomplete="one-time-code"]:visible',
          'input[name*="captcha" i]:visible',
          'input[placeholder*="验证码"]:visible',
          'input[placeholder*="verification code" i]:visible',
        ].join(','),
      )
      .count(),
  );
}
