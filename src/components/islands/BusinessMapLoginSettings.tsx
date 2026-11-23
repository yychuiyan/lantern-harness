import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import SelectDropdown from './SelectDropdown';
import { PmIcon } from './PmShared';
import { showToast } from './Toast';
import {
  businessLoginRequest,
  DEFAULT_LOGIN_CONFIG,
  type BusinessLoginStatus,
  type BusinessLoginConfig,
} from '../../lib/business-map-login';

export interface BusinessLoginSettingsHandle {
  save: () => Promise<void>;
}
interface Props {
  systemId: string;
  entryChanged?: boolean;
}

type VerificationState = 'idle' | 'success' | 'waiting' | 'error';

const BusinessMapLoginSettings = forwardRef<BusinessLoginSettingsHandle, Props>(
  function BusinessMapLoginSettings({ systemId, entryChanged = false }, ref) {
    const [config, setConfig] = useState({ ...DEFAULT_LOGIN_CONFIG });
    const [password, setPassword] = useState('');
    const [result, setResult] = useState<BusinessLoginStatus | null>(null);
    const [dirty, setDirty] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');
    const [verification, setVerification] = useState<VerificationState>('idle');
    const waiting = result?.status === 'awaiting_login';
    const disabled = loading || !result || Boolean(busy) || waiting;
    function apply(data: BusinessLoginStatus) {
      setResult(data);
      setConfig({ ...DEFAULT_LOGIN_CONFIG, ...data.config });
      setPassword('');
      setDirty(false);
    }
    useEffect(() => {
      let alive = true;
      void businessLoginRequest(systemId)
        .then((data) => {
          if (alive) apply(data);
        })
        .catch((e) => {
          if (alive) showToast(e.message, 'error');
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
      return () => {
        alive = false;
      };
    }, [systemId]);
    useEffect(() => {
      if (!waiting) return;
      const timer = window.setInterval(() => {
        void businessLoginRequest(systemId)
          .then((data) => {
            setResult(data);
            if (data.status === 'ready') setVerification('success');
          })
          .catch((e) => {
            showToast(e.message, 'error');
            setResult((previous) => (previous ? { ...previous, status: 'idle' } : null));
          });
      }, 2000);
      return () => window.clearInterval(timer);
    }, [systemId, waiting]);
    function change<K extends keyof BusinessLoginConfig>(key: K, value: BusinessLoginConfig[K]) {
      setConfig((previous) => ({ ...previous, [key]: value }));
      setDirty(true);
      setNotice('');
      setVerification('idle');
    }
    async function save() {
      if (!dirty) return;
      if (!result) throw new Error('当前登录配置接口不可用，请重启 Lantern 服务后再试');
      if (loading || busy) throw new Error('登录配置正在处理，请稍后再保存');
      const data = await businessLoginRequest(systemId, '', 'PUT', {
        ...config,
        password,
      });
      apply(data);
    }
    useImperativeHandle(ref, () => ({ save }));
    async function run(action: 'start' | 'complete' | 'cancel') {
      setNotice('');
      try {
        setBusy(action);
        // 保存与登录共用当前表单，主面板的「保存设置」也会保存未完成的登录配置。
        if (action === 'start') await save();
        const data = await businessLoginRequest(systemId, action, 'POST', {});
        apply(data);
        if (action === 'start' || action === 'complete') {
          setVerification(
            data.status === 'ready'
              ? 'success'
              : data.status === 'awaiting_login'
                ? 'waiting'
                : 'idle',
          );
        } else {
          setVerification('idle');
        }
        const message = data.message || (action === 'cancel' ? '已关闭登录窗口' : '登录操作已完成');
        if (data.status === 'awaiting_login') setNotice(message);
        else showToast(message, 'success');
      } catch (e) {
        if (action === 'start' || action === 'complete') setVerification('error');
        showToast(e instanceof Error ? e.message : '登录操作失败', 'error');
      } finally {
        setBusy('');
      }
    }
    return (
      <section className="tw-bm-login-settings tw-bm-form" aria-label="系统登录配置">
        <h3>登录配置</h3>
        <p className="tw-bm-form-note">
          账号密码和登录态仅保存在当前空间的本机配置，不写入业务地图或发送给模型；配置会随「保存设置」或「验证登录」一并保存。
        </p>
        <label>
          <span>登录方式</span>
          <SelectDropdown
            ariaLabel="登录方式"
            value={config.mode}
            disabled={disabled}
            onChange={(mode) => change('mode', mode)}
            options={[
              { value: 'none', label: '无需登录' },
              { value: 'password', label: '账号密码登录' },
              { value: 'sso', label: 'SSO / 接口登录' },
              { value: 'manual', label: '手动登录（验证码 / 扫码）' },
            ]}
          />
        </label>
        {config.mode !== 'none' ? (
          <>
            {config.mode !== 'sso' ? (
              <label>
                <span>登录地址（可选，默认系统入口）</span>
                <input
                  value={config.loginUrl}
                  disabled={disabled}
                  placeholder="https://..."
                  onChange={(e) => change('loginUrl', e.target.value)}
                />
              </label>
            ) : null}
            {config.mode === 'password' || config.mode === 'sso' ? (
              <div className="two">
                <label>
                  <span>登录账号</span>
                  <input
                    value={config.username}
                    disabled={disabled}
                    autoComplete="off"
                    onChange={(e) => change('username', e.target.value)}
                  />
                </label>
                <label>
                  <span>登录密码</span>
                  <input
                    type="password"
                    value={password}
                    disabled={disabled}
                    autoComplete="new-password"
                    placeholder={result?.hasPassword ? '••••••••••••' : '请输入密码'}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setDirty(true);
                      setVerification('idle');
                    }}
                  />
                </label>
              </div>
            ) : null}
            {config.mode === 'sso' ? (
              <>
                <label>
                  <span>登录接口地址</span>
                  <input
                    value={config.endpoint}
                    disabled={disabled}
                    placeholder="https://... 或 /api/login"
                    onChange={(e) => change('endpoint', e.target.value)}
                  />
                </label>
                <label>
                  <span>请求体模板</span>
                  <textarea
                    rows={3}
                    value={config.bodyTemplate}
                    disabled={disabled}
                    onChange={(e) => change('bodyTemplate', e.target.value)}
                  />
                </label>
                <p className="tw-bm-form-note">
                  {
                    '使用 {{username}} 和 {{password}} 引用账号密码。接口需支持返回 Token 或 Cookie；验证码不会自动绕过。'
                  }
                </p>
                <div className="two">
                  <label>
                    <span>Token 路径（可选）</span>
                    <input
                      value={config.tokenPath}
                      disabled={disabled}
                      placeholder="data.token"
                      onChange={(e) => change('tokenPath', e.target.value)}
                    />
                  </label>
                  <label>
                    <span>Token 存储名称</span>
                    <input
                      value={config.tokenStorageKey}
                      disabled={disabled}
                      onChange={(e) => change('tokenStorageKey', e.target.value)}
                    />
                  </label>
                </div>
              </>
            ) : null}
            {config.mode === 'password' ? (
              <details>
                <summary>自定义登录控件（可选）</summary>
                <div className="tw-bm-form">
                  {(
                    [
                      ['usernameSelector', '账号输入框'],
                      ['passwordSelector', '密码输入框'],
                      ['submitSelector', '登录按钮'],
                    ] as const
                  ).map(([name, label]) => (
                    <label key={name}>
                      <span>{label}选择器</span>
                      <input
                        value={config[name]}
                        disabled={disabled}
                        onChange={(e) => change(name, e.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </details>
            ) : null}
          </>
        ) : null}
        {config.mode !== 'none' ? (
          <div
            className={`tw-bm-login-status is-${
              busy === 'start'
                ? 'checking'
                : verification === 'idle' && result?.stateReady && !dirty
                  ? 'ready'
                  : verification
            }`}
            role="status"
          >
            <div className="tw-bm-login-status-copy">
              <span className="tw-bm-login-status-icon" aria-hidden="true">
                <PmIcon
                  name={
                    busy === 'start'
                      ? 'sliders'
                      : verification === 'error'
                        ? 'bug'
                        : verification === 'success' || (result?.stateReady && !dirty)
                          ? 'check'
                          : config.mode === 'manual'
                            ? 'play'
                            : 'file'
                  }
                  size={15}
                />
              </span>
              <div>
                <strong>
                  {busy === 'start'
                    ? '正在验证登录'
                    : verification === 'success'
                      ? '登录验证成功'
                      : verification === 'waiting'
                        ? '等待完成登录'
                        : verification === 'error'
                          ? '登录验证失败'
                          : dirty
                            ? '配置已修改'
                            : result?.stateReady
                              ? '登录状态已就绪'
                              : config.mode === 'manual'
                                ? '手动登录待验证'
                                : '尚未验证登录'}
                </strong>
                <p>
                  {entryChanged
                    ? '系统入口已修改，请先保存系统设置再做登录验证。'
                    : busy === 'start'
                      ? config.mode === 'manual'
                        ? '正在保存配置并打开登录页面。'
                        : '正在保存配置并检查账号、Token 或浏览器登录态。'
                      : verification === 'success'
                        ? '账号与登录态验证通过，自动识别可直接复用。'
                        : verification === 'waiting'
                          ? notice ||
                            result?.message ||
                            (config.mode === 'manual'
                              ? '登录页面已打开；完成登录并进入业务系统后，回到这里点「保存登录态」。'
                              : '请在登录窗口完成验证码、扫码或二次验证。')
                          : verification === 'error'
                            ? '请检查账号、密码、接口地址或登录页面后重试。'
                            : result?.stateReady
                              ? dirty
                                ? config.mode === 'manual'
                                  ? '已切换到手动登录；点击「打开登录页面」会跳转登录地址，完成登录后回来点击「保存登录态」。'
                                  : config.mode === 'sso'
                                    ? '当前修改尚未验证；点击「验证接口登录」会先保存再检查。'
                                    : '当前修改尚未验证；点击「验证账号密码」会先保存再检查。'
                                : '已保存有效登录态，可继续自动识别或重新验证。'
                              : config.mode === 'manual'
                                ? '点击「打开登录页面」后完成登录；登录态不会自动保存，需回来点「保存登录态」。'
                                : dirty
                                  ? config.mode === 'sso'
                                    ? '保存设置会保存配置；点击「验证接口登录」会调用接口并检查 Token / Cookie。'
                                    : '保存设置会保存配置；点击「验证账号密码」会打开页面并检查登录态。'
                                  : config.mode === 'sso'
                                    ? '验证会直接调用登录接口并检查返回的 Token / Cookie。'
                                    : '验证会打开登录页面，自动填写账号密码；遇到验证码时等待你完成。'}
                </p>
              </div>
            </div>
            <div className="tw-bm-login-actions">
              {!waiting ? (
                <button
                  className="tw-bm-btn primary"
                  type="button"
                  disabled={disabled || entryChanged}
                  onClick={() => void run('start')}
                >
                  <PmIcon name={config.mode === 'manual' ? 'play' : 'check'} size={14} />
                  {busy === 'start'
                    ? '验证中…'
                    : config.mode === 'manual'
                      ? '打开登录页面'
                      : config.mode === 'sso'
                        ? '验证接口登录'
                        : '验证账号密码'}
                </button>
              ) : (
                <>
                  <button
                    className="tw-bm-btn primary"
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void run('complete')}
                  >
                    {busy === 'complete' ? '保存中…' : '保存登录态'}
                  </button>
                  <button
                    className="tw-bm-btn"
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void run('cancel')}
                  >
                    取消登录
                  </button>
                </>
              )}
            </div>
          </div>
        ) : null}
      </section>
    );
  },
);
export default BusinessMapLoginSettings;
