export const CASE_BACKUP_DIR_NAME = '备份列表';

function partsOf(relativePath) {
  return String(relativePath ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean);
}

export function isCaseBackupPath(relativePath) {
  return partsOf(relativePath).includes(CASE_BACKUP_DIR_NAME);
}

/** 分类目录的第一段就是用例类型目录；根目录历史文件没有类型目录。 */
export function caseTypeFolderForPath(relativePath) {
  const parts = partsOf(relativePath);
  if (!parts.length || parts[0] === CASE_BACKUP_DIR_NAME || parts.includes(CASE_BACKUP_DIR_NAME)) {
    return '';
  }
  return parts.length > 1 ? parts[0] : '';
}

/** 新备份落在源用例所属类型的「备份列表」；根目录历史文件继续使用根备份目录。 */
export function backupDirectoryForCasePath(relativePath) {
  const typeFolder = caseTypeFolderForPath(relativePath);
  return typeFolder ? `${typeFolder}/${CASE_BACKUP_DIR_NAME}` : CASE_BACKUP_DIR_NAME;
}
