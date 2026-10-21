/**
 * 用例类型维护弹窗：新增 / 重命名 / 删除。
 *
 * 交互与外观和「提示词类型」「知识库分类」共用 NameEditDialog，
 * 这里只补用例类型特有的模板目录说明。
 */
import NameEditDialog, { type NameEditMode } from './NameEditDialog';

export type CaseTypeDialogMode = NameEditMode;

interface Props {
  mode: CaseTypeDialogMode | null;
  /** 当前类型名：编辑时预填，删除时用于提示 */
  currentLabel: string;
  /** 编辑/删除的目标类型模板目录（用于提示会用到哪个模板文件夹） */
  templateFolder: string;
  /** 提交失败的原因（重名、名字为空等）：弹窗不关，就地提示 */
  error?: string;
  onClose: () => void;
  onSubmit: (label: string) => void;
  onDelete: () => void;
}

export default function CaseTypeDialog({
  mode,
  currentLabel,
  templateFolder,
  error = '',
  onClose,
  onSubmit,
  onDelete,
}: Props) {
  return (
    <NameEditDialog
      mode={mode}
      entityLabel="用例类型"
      currentLabel={currentLabel}
      placeholder="如：安全测试"
      error={error}
      onClose={onClose}
      onSubmit={onSubmit}
      onDelete={onDelete}
      deleteMessage={(label) => (
        <>确定删除「{label}」？已有用例与模板不会被删除，但该类型将不再出现在生成配置里。</>
      )}
      deleteNote={<>关联模板目录：测试模板库/{templateFolder}/</>}
      hint={(name) => <>模板目录随名称生成：测试模板库/{name || '名称'}用例/</>}
    />
  );
}
