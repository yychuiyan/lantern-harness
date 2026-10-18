/**
 * 平台版本号：唯一来源是根目录 `package.json`（发版只改 `version`）。
 *
 * 以前这里另存一份字符串常量，0.1.3 发版时忘了同步，出现「功能已是 0.1.3、
 * 侧栏还显示 0.1.2」。CLI 的 `lantern version` 同样读 `package.json`，两边天然一致。
 */
import { version } from '../../package.json';

export const APP_VERSION: string = version;
