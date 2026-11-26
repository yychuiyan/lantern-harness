import JSZip from 'jszip';

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const unique = (items) => [...new Set(items.filter(Boolean))];

function flattenOutline(items) {
  return (items || []).flatMap((item) => [item, ...flattenOutline(item?.children)]);
}

function normalizedHeader(value) {
  return String(value || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s*＊・·:：]/g, '')
    .toLowerCase();
}

function findHeader(headers, predicates) {
  return headers.find((header) => {
    const value = normalizedHeader(header);
    return predicates.some((predicate) => predicate(value));
  });
}

function idsIn(value, prefix) {
  const pattern = new RegExp(`\\b${prefix}-[A-Za-z0-9_-]+\\b`, 'gi');
  return unique(
    [...String(value || '').matchAll(pattern)].map((match) =>
      prefix === 'RO' ? match[0].replace(/^ro-/i, 'RO-') : match[0].toUpperCase(),
    ),
  );
}

function naturalIdCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

/** 模板缺少“引用需求点”时补齐，保证需求编号与来源追踪分开。 */
export function ensureCitationHeader(headers) {
  const next = unique((headers || []).map((header) => String(header || '').trim()).filter(Boolean));
  const found = findHeader(next, [
    (value) => value === '引用需求点',
    (value) => value === '需求点',
    (value) => value === '关联需求点',
    (value) => value === 'reqcite',
    (value) => value === 'reqpoint',
  ]);
  return found ? next : [...next, '引用需求点'];
}

function xqCode(item) {
  return (
    `${item?.quote || ''} ${item?.body || ''} ${item?.title || ''}`.match(
      /\bXQ-[A-Za-z0-9-]+\b/,
    )?.[0] || ''
  );
}

function citation(item) {
  if (!item) return '';
  const label = text(item.title) || text(item.quote);
  return label ? `${item.id} ${label.replace(/\s+/g, ' ')}` : item.id;
}

function requirementHierarchy(tree) {
  const byCode = new Map();
  const stack = [];
  for (const item of tree || []) {
    const depth = Number(item?.depth);
    const title = text(item?.title);
    if (!Number.isInteger(depth) || !title) continue;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const code = title.match(/\bXQ-[A-Za-z0-9-]+\b/)?.[0];
    if (code) {
      byCode.set(code.toUpperCase(), {
        system: stack.find((ancestor) => ancestor.depth === 1)?.title || '',
        feature: stack.find((ancestor) => ancestor.depth === 2)?.title || '',
      });
    }
    stack.push({ depth, title });
  }
  return byCode;
}

/**
 * 将模型输出统一到 Lantern 技能口径：
 * - “需求编号”填写需求文档根需求 XQ；
 * - “引用需求点”单独保存真实 RO + TP；
 * - 按需求条目顺序、条目内测试点顺序稳定排序；
 * - 用例编号重新连续编号。
 */
export function normalizeGeneratedCaseRows(rows, headers, analysis, tree = []) {
  const nextHeaders = ensureCitationHeader(headers);
  if (!analysis || !Array.isArray(rows) || !rows.length) {
    return { headers: nextHeaders, rows: Array.isArray(rows) ? rows : [] };
  }

  const outline = flattenOutline(analysis.outline);
  const byId = new Map(outline.map((item) => [item.id, item]));
  const outlineRank = new Map(outline.map((item, index) => [item.id, index]));
  const testPoints = analysis.testPoints?.points || [];
  const testPointRank = new Map(testPoints.map((item, index) => [item.id, index]));
  const stories = new Map((analysis.stories || []).map((item) => [item.id, item]));
  const pointStories = new Map(testPoints.map((item) => [item.id, item.storyId]));
  const requirementHeader = findHeader(nextHeaders, [
    (value) => value === '需求编号',
    (value) => value === '关联需求',
    (value) => value === '需求id',
    (value) => value === '需求',
  ]);
  const citationHeader = findHeader(nextHeaders, [
    (value) => value === '引用需求点',
    (value) => value === '需求点',
    (value) => value === '关联需求点',
    (value) => value === 'reqcite',
    (value) => value === 'reqpoint',
  ]);
  const numberHeader = findHeader(nextHeaders, [
    (value) => value === '用例编号',
    (value) => value === '测试用例编号',
    (value) => value === '用例id',
    (value) => value === 'no',
  ]);
  const titleHeader = findHeader(nextHeaders, [
    (value) => value === '用例标题',
    (value) => value === '用例名称',
    (value) => value === '标题',
    (value) => value === 'title',
  ]);
  const moduleHeader = findHeader(nextHeaders, [
    (value) => value === '模块',
    (value) => value === '测试项目',
    (value) => value === '大模块',
    (value) => value === '所属模块',
  ]);
  const submoduleHeader = findHeader(nextHeaders, [
    (value) => value === '子模块',
    (value) => value === '小模块',
    (value) => value === '测试分项目',
    (value) => value === '二级模块',
  ]);
  const hierarchy = requirementHierarchy(tree);

  const rootOf = (id) => {
    let item = byId.get(id);
    const seen = new Set();
    while (item?.parentId && byId.has(item.parentId) && !seen.has(item.id)) {
      seen.add(item.id);
      item = byId.get(item.parentId);
    }
    return item;
  };

  const decorated = rows.map((row, index) => {
    const source = {
      ...Object.fromEntries(
        nextHeaders.map((header) => [header, row?.[header] == null ? '' : String(row[header])]),
      ),
    };
    const requirementText = requirementHeader ? source[requirementHeader] : '';
    const citationText = citationHeader ? source[citationHeader] : '';
    const titleText = titleHeader ? source[titleHeader] : '';
    const combined = [requirementText, citationText, titleText].join(' ');
    const usIds = idsIn(combined, 'US');
    const directRoIds = idsIn(combined, 'RO');
    const tpIds = idsIn(combined, 'TP');
    const inferredRoIds = unique(
      usIds.flatMap((id) => stories.get(id)?.sourceRefs || stories.get(id)?.source_refs || []),
    );
    const roIds = directRoIds.length ? directRoIds : inferredRoIds;
    const inferredStories = unique([
      ...usIds,
      ...roIds.flatMap((id) =>
        (analysis.stories || [])
          .filter((story) => (story.sourceRefs || []).includes(id))
          .map((story) => story.id),
      ),
      ...tpIds.map((id) => pointStories.get(id)).filter(Boolean),
    ]);
    const roots = unique(roIds.map((id) => rootOf(id)?.id).filter(Boolean));
    const requirementRoot = roots
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort(
        (left, right) =>
          (outlineRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (outlineRank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      )[0];
    const requirementCode = xqCode(requirementRoot);
    const roRank = roIds.length
      ? Math.min(
          ...roIds.map((id) => {
            const root = rootOf(id);
            return outlineRank.get(root?.id) ?? Number.MAX_SAFE_INTEGER;
          }),
        )
      : Math.min(
          ...inferredStories.flatMap((storyId) =>
            (stories.get(storyId)?.sourceRefs || []).map((id) => {
              const root = rootOf(id);
              return outlineRank.get(root?.id) ?? Number.MAX_SAFE_INTEGER;
            }),
          ),
          Number.MAX_SAFE_INTEGER,
        );
    const tpRank = tpIds.length
      ? Math.min(...tpIds.map((id) => testPointRank.get(id) ?? Number.MAX_SAFE_INTEGER))
      : Number.MAX_SAFE_INTEGER;
    const citeParts = [
      ...roIds.map((id) => citation(byId.get(id)) || id),
      ...tpIds.sort(naturalIdCompare),
    ];

    if (requirementHeader) source[requirementHeader] = requirementCode || '无';
    const moduleInfo = requirementCode ? hierarchy.get(requirementCode.toUpperCase()) : null;
    if (moduleHeader && moduleInfo?.system) source[moduleHeader] = moduleInfo.system;
    if (submoduleHeader && moduleInfo?.feature) source[submoduleHeader] = moduleInfo.feature;
    if (citationHeader) source[citationHeader] = citeParts.join('；');
    return {
      row: source,
      index,
      roRank,
      tpRank,
      tpId: [...tpIds].sort(naturalIdCompare)[0] || '',
    };
  });

  decorated.sort((left, right) => {
    if (left.roRank !== right.roRank) return left.roRank - right.roRank;
    if (left.tpRank !== right.tpRank) return left.tpRank - right.tpRank;
    if (left.tpId !== right.tpId) return naturalIdCompare(left.tpId, right.tpId);
    return left.index - right.index;
  });

  const normalizedRows = decorated.map(({ row }, index) => {
    if (numberHeader) row[numberHeader] = String(index + 1);
    return row;
  });
  return { headers: nextHeaders, rows: normalizedRows };
}

const CASE_SHEET_DROPDOWNS = {
  实际结果: ['P', 'F'],
  优先级: ['P0', 'P1', 'P2', 'P3'],
  用例状态: ['待验证', '通过', '不通过', '阻塞', '跳过'],
};

function colLetter(index) {
  let value = index;
  let result = '';
  while (value >= 0) {
    result = String.fromCharCode((value % 26) + 65) + result;
    value = Math.floor(value / 26) - 1;
  }
  return result;
}

function dataValidationsXml(headers) {
  const items = headers.flatMap((header, index) => {
    const options = CASE_SHEET_DROPDOWNS[header];
    if (!options?.length) return [];
    const column = colLetter(index);
    return [
      `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${column}2:${column}1048576"><formula1>"${options.join(',')}"</formula1></dataValidation>`,
    ];
  });
  return items.length
    ? `<dataValidations count="${items.length}">${items.join('')}</dataValidations>`
    : '';
}

function freezeHeaderRow(sheet) {
  const pane =
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
  if (/<pane\b[^>]*state="frozen"/.test(sheet)) return sheet;
  const selfClosing = sheet.match(/<sheetView\b([^>]*)\/>/);
  if (selfClosing)
    return sheet.replace(selfClosing[0], `<sheetView${selfClosing[1]}>${pane}</sheetView>`);
  const sheetView = sheet.match(/<sheetView\b([^>]*)>([\s\S]*?)<\/sheetView>/);
  if (!sheetView) return sheet;
  const attrs = sheetView[1];
  const body = sheetView[2].replace(/<pane\b[^>]*\/>/g, '').replace(/<selection\b[^>]*\/>/g, '');
  return sheet.replace(sheetView[0], `<sheetView${attrs}>${pane}${body}</sheetView>`);
}

/**
 * SheetJS 写出的 workbook 没有换行和下拉样式；保存后补同模板体验。
 * 数据行不写固定高度，让 Excel 按 wrapText 内容自适应。
 */
export async function polishCaseWorkbook(buffer, headers) {
  const zip = await JSZip.loadAsync(buffer);
  const stylesFile = zip.file('xl/styles.xml');
  let wrapXf = 1;
  let headerXf = 1;
  if (stylesFile) {
    let styles = await stylesFile.async('string');
    styles = styles
      .replace(/<fonts([^>]*)count="(\d+)"/, (_, attrs, count) => {
        return `<fonts${attrs}count="${Number(count) + 1}"`;
      })
      .replace(
        '</fonts>',
        '<font><b/><sz val="11"/><color theme="1"/><name val="Microsoft YaHei"/></font></fonts>',
      );
    const fontCount = Number(styles.match(/<fonts[^>]*count="(\d+)"/)?.[1] ?? 2);
    const previousXfCount = Number(styles.match(/<cellXfs[^>]*count="(\d+)"/)?.[1] ?? 1);
    wrapXf = previousXfCount;
    headerXf = previousXfCount + 1;
    styles = styles
      .replace(
        /<cellXfs([^>]*)count="(\d+)"/,
        (_, attrs) => `<cellXfs${attrs}count="${previousXfCount + 2}"`,
      )
      .replace(
        '</cellXfs>',
        `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="${fontCount - 1}" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs>`,
      );
    zip.file('xl/styles.xml', styles);
  }

  const validations = dataValidationsXml(headers);
  for (const sheetPath of Object.keys(zip.files).filter((name) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  )) {
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) continue;
    let sheet = await sheetFile.async('string');
    sheet = freezeHeaderRow(sheet);
    sheet = sheet.replace(/<c\b([^>]*)>/g, (full, attrs) => {
      const row = Number(/\br="([A-Z]+)(\d+)"/.exec(attrs)?.[2] || 0);
      if (row === 1) {
        const next = /\bs="\d+"/.test(attrs)
          ? attrs.replace(/\bs="\d+"/, `s="${headerXf}"`)
          : ` s="${headerXf}"${attrs}`;
        return `<c${next}>`;
      }
      if (!/\bt="str"/.test(attrs)) return full;
      const next = /\bs="\d+"/.test(attrs) ? attrs : ` s="${wrapXf}"${attrs}`;
      return `<c${next}>`;
    });
    sheet = sheet.replace(/<row r="(\d+)"([^>]*)>/g, (_full, row, attrs) => {
      const clean = attrs.replace(/\s(?:ht|customHeight)="[^"]*"/g, '');
      return Number(row) === 1
        ? `<row r="${row}" ht="30" customHeight="1"${clean}>`
        : `<row r="${row}"${clean}>`;
    });
    if (validations && !sheet.includes('<dataValidations')) {
      if (sheet.includes('<ignoredErrors')) {
        sheet = sheet.replace('<ignoredErrors', `${validations}<ignoredErrors`);
      } else {
        sheet = sheet.replace('</sheetData>', `</sheetData>${validations}`);
      }
    }
    zip.file(sheetPath, sheet);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
