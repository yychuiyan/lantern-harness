import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';

import {
  closeBashSession,
  openBashSession,
  resetBashSessionsForTests,
  signalBashSession,
  writeBashSession,
} from '../../builtin/session/bash-session.mjs';
import { buildChildEnv, resolveSandboxPolicy } from '../../builtin/session/sandbox-policy.mjs';

describe('bash-session write/signal', () => {
  after(() => {
    resetBashSessionsForTests();
  });

  it('write 与 signal 对未知会话报错；open 后 write 成功', async () => {
    resetBashSessionsForTests();
    assert.equal(writeBashSession({ sessionId: 'missing', data: 'x' }).ok, false);
    assert.equal(signalBashSession({ sessionId: 'missing', signal: 'SIGINT' }).ok, false);
    assert.match(
      String(signalBashSession({ sessionId: 'x', signal: 'SIGKILL' }).error ?? ''),
      /unsupported/,
    );

    const cwdAbs = os.tmpdir();
    const policy = resolveSandboxPolicy({ access: 'full', workspace: cwdAbs });
    const opened = await openBashSession({
      cwdAbs,
      cwdDisplay: path.basename(cwdAbs) || cwdAbs,
      env: buildChildEnv(policy),
    });
    assert.equal(opened.ok, true);
    const sid = opened.sessionId as string;
    const w = writeBashSession({ sessionId: sid, data: 'echo ok', submit: true });
    assert.equal(w.ok, true);
    assert.ok((w.bytes as number) > 0);
    const sig = signalBashSession({ sessionId: sid, signal: 'SIGINT' });
    assert.equal(sig.ok, true);
    assert.equal(sig.signal, 'SIGINT');
    closeBashSession(sid);
  });
});
