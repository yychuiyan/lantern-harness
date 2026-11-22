/**
 * 探索碰到登录墙时的手动三选一：
 * UI 登录编排（纯账密）/ SSO 接口登录 / 我已登录继续。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';

import type { LoginWallChoice, LoginWallSuggestion } from '../../lib/ui-auto-login-wall';

const OPTIONS: Array<{
  id: LoginWallChoice;
  title: string;
  desc: string;
}> = [
  {
    id: 'ui_orchestrate',
    title: '新增登录用例编排',
    desc: '适合只需输入账号密码的登录页：单独建一条登录编排，绑定位器后出码。',
  },
  {
    id: 'sso',
    title: '使用 SSO / 接口登录',
    desc: '适合验证码、2FA、强制单点等不可避免因素：按项目环境里的 LOGIN_API_* 拿 token 并落盘。',
  },
  {
    id: 'continue',
    title: '手动登录后继续',
    desc: '浏览器保持打开：你先自己登录（含验证码），登完后点右侧「我已登录，继续」。',
  },
];

export default function LoginWallDialog({
  open,
  suggestion,
  evidence,
  ssoConfigured,
  busy,
  onClose,
  onChoose,
}: {
  open: boolean;
  suggestion: LoginWallSuggestion;
  /** 触发检测的摘要，给用户看 */
  evidence?: string;
  /** 环境里是否已配登录接口地址（LOGIN_API_PATH / LOGIN_API_URL 等） */
  ssoConfigured?: boolean;
  busy?: boolean;
  onClose: () => void;
  onChoose: (choice: LoginWallChoice) => void;
}) {
  return (
    <Dialog open={open} onClose={() => (busy ? undefined : onClose())} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/30" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-md rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          <DialogTitle className="text-[15px] font-semibold text-stone-800">
            检测到需要登录
          </DialogTitle>
          <p className="mt-1.5 text-[13px] leading-relaxed text-stone-500">
            自动 SSO / auth.setup
            不可用或未成功时才会看到此窗。请选择怎么处理；平台只给建议，不会替你自动选定。
            {suggestion === 'sso'
              ? '当前信号更像验证码 / SSO，建议走接口登录。'
              : '当前信号更像纯账密登录，建议新增登录编排。'}
          </p>
          {evidence?.trim() ? (
            <p className="mt-2 max-h-16 overflow-auto rounded-lg bg-stone-50 px-2.5 py-2 text-[12px] leading-5 text-stone-500">
              {evidence.trim().slice(0, 280)}
            </p>
          ) : null}
          <div className="mt-4 flex flex-col gap-2">
            {OPTIONS.map((opt) => {
              const recommended = opt.id === suggestion;
              const ssoDisabled = opt.id === 'sso' && ssoConfigured === false;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={busy || ssoDisabled}
                  onClick={() => onChoose(opt.id)}
                  className={[
                    'rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                    recommended
                      ? 'border-[#4176e6] bg-[#4176e6]/06 ring-1 ring-[#4176e6]/30'
                      : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50',
                  ].join(' ')}
                >
                  <span className="flex items-center gap-2 text-[13px] font-medium text-stone-800">
                    {opt.title}
                    {recommended ? (
                      <span className="rounded-full bg-[#4176e6]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#4176e6]">
                        建议
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-5 text-stone-500">
                    {ssoDisabled
                      ? '尚未配置登录接口地址（LOGIN_API_PATH / LOGIN_API_URL 或其它 LOGIN_API_*）。请先在「环境配置」填写。'
                      : opt.desc}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              className="h-8 rounded-lg px-3 text-[13px] text-stone-500 hover:bg-stone-50 hover:text-stone-800 disabled:opacity-40"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
