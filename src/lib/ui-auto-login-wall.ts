/**
 * 登录墙：检测建议 + 自动拿 token 链（SSO → auth.setup）+ 手动三选一回落。
 */
import type { UiPlanStep } from './ui-auto-agent';

/** 项目记住的登录策略偏好 */
export type LoginStrategy = 'ask_each_time' | 'ui_orchestrate' | 'sso';

export type LoginWallChoice = 'ui_orchestrate' | 'sso' | 'continue';

/** 建议走哪条（可被用户覆盖） */
export type LoginWallSuggestion = 'ui_orchestrate' | 'sso';

export const LOGIN_STRATEGY_LABELS: Record<LoginStrategy, string> = {
  ask_each_time: '每次询问',
  ui_orchestrate: '优先 UI 登录编排',
  sso: '优先 SSO / 接口登录',
};

/** 项目配置里选中某偏好时的一句说明 */
export const LOGIN_STRATEGY_HINTS: Record<LoginStrategy, string> = {
  ask_each_time: '撞墙弹窗按页面信号给建议，不预选固定路径。',
  ui_orchestrate: '弹窗建议「新增登录编排」，适合纯账密、无验证码。',
  sso: '弹窗建议「接口登录」；需在环境配置填写 LOGIN_API_*。',
};

const CAPTCHA_RE = /验证码|captcha|2fa|mfa|otp|短信验证|扫码|单点登录|\bsso\b|oauth|saml/i;
const LOGIN_PAGE_RE = /登录|登\s*录|sign\s*in|log\s*in|password|用户名|账号/i;
const NEED_LOGIN_RE = /需要登录|手动登录|未登录|请先登录|login\s*required|unauthorized|401/i;

export function normalizeLoginStrategy(raw: unknown): LoginStrategy {
  if (raw === 'ui_orchestrate' || raw === 'sso' || raw === 'ask_each_time') return raw;
  return 'ask_each_time';
}

/** 文本/快照里是否像碰到登录墙 */
export function detectLoginWall(text: string): boolean {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  return CAPTCHA_RE.test(raw) || NEED_LOGIN_RE.test(raw) || LOGIN_PAGE_RE.test(raw);
}

/** 是否像「不可避免」因素（验证码 / SSO / 2FA）→ 建议 SSO */
export function detectHardLoginFactors(text: string): boolean {
  return CAPTCHA_RE.test(String(text || ''));
}

export function suggestLoginWallPath(text: string): LoginWallSuggestion {
  return detectHardLoginFactors(text) ? 'sso' : 'ui_orchestrate';
}

/**
 * 按项目偏好解析本次应高亮的选项；ask_each_time 用检测建议。
 */
export function resolveLoginWallHighlight(
  preference: LoginStrategy | undefined,
  evidence: string,
): LoginWallSuggestion {
  const pref = normalizeLoginStrategy(preference);
  if (pref === 'ui_orchestrate' || pref === 'sso') return pref;
  return suggestLoginWallPath(evidence);
}

/** 登录墙自动链要依次尝试的步骤（成功即停；全失败再弹窗） */
export type LoginWallAutoStep = 'sso' | 'auth_setup';

/**
 * 有登录用例先跑用例拿 token，再回落平台 SSO。
 * 与项目偏好无关：有能力就静默尝试。
 */
export function loginWallAutoSteps(opts: {
  ssoConfigured?: boolean;
  authSetupDetected?: boolean;
}): LoginWallAutoStep[] {
  const steps: LoginWallAutoStep[] = [];
  if (opts.authSetupDetected) steps.push('auth_setup');
  if (opts.ssoConfigured) steps.push('sso');
  return steps;
}

/** 一键「登录并保存登录态」编排的默认步骤 */
export function buildLoginOrchestratePlan(loginPath = '/login'): UiPlanStep[] {
  const path = String(loginPath || '/login').trim() || '/login';
  return [
    {
      id: 'login_goto',
      action: 'goto',
      target: '打开登录页',
      url: path,
      status: 'pending',
    },
    {
      id: 'login_user',
      action: 'fill',
      target: '用户名 / 账号输入框',
      value: '${ADMIN_USERNAME}',
      status: 'pending',
    },
    {
      id: 'login_pass',
      action: 'fill',
      target: '密码输入框',
      value: '${ADMIN_PASSWORD}',
      status: 'pending',
    },
    {
      id: 'login_submit',
      action: 'click',
      target: '登录按钮',
      status: 'pending',
    },
    {
      id: 'login_left',
      action: 'expect',
      target: '已进入系统（不再停留在登录页）',
      status: 'pending',
    },
  ];
}

export function loginOrchestrateTitle(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `登录并保存登录态 ${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
