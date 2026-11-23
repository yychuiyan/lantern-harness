import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveToastTone } from './Toast';

describe('Toast tone', () => {
  it('把省略 tone 的新增、保存和删除提示识别为成功', () => {
    assert.equal(resolveToastTone('业务系统已创建'), 'success');
    assert.equal(resolveToastTone('系统设置已保存'), 'success');
    assert.equal(resolveToastTone('技能已导入，脚本不会自动运行'), 'success');
    assert.equal(resolveToastTone('业务流程已删除'), 'success');
    assert.equal(resolveToastTone('已撤回 3 项识别结果'), 'success');
  });

  it('显式 tone 优先于文案推断', () => {
    assert.equal(resolveToastTone('系统设置已保存', 'info'), 'info');
    assert.equal(resolveToastTone('操作已完成', 'error'), 'error');
  });

  it('没有显式 tone 的失败文案不会显示成成功', () => {
    assert.equal(resolveToastTone('保存空间失败：磁盘已满'), 'error');
    assert.equal(resolveToastTone('请先配置模型'), 'error');
  });

  it('中性进行中提示保持 info', () => {
    assert.equal(resolveToastTone('识别已在后台启动，可离开页面'), 'info');
  });
});
