// Bilingual copy for surfaces OUTSIDE the sidebar bundle — today the code-
// chain panel, which builds as its own esbuild entry and must not drag the
// sidebar dictionary into its bundle. The mechanism (host-injected
// `vscode-language` meta, `zh` prefix) is deliberately identical to
// `sidebar/webview/lib/i18n.ts`; keys live here only for the shared/panel
// surfaces. Components take every string from `t` — inline copy is
// forbidden so the two locales cannot drift.

type Entry = {
  en: string | ((...args: number[]) => string);
  zh: string | ((...args: number[]) => string);
};

const DICT = {
  // ── code-chain panel (§6.2/§6.3) ────────────────────────────────────────
  cc_nodes_stats: {
    en: (n: number, u: number) =>
      `${n} node${n === 1 ? '' : 's'}${u ? ` · ${u} unresolved` : ''}`,
    zh: (n: number, u: number) => `${n} 个节点${u ? ` · ${u} 未解析` : ''}`,
  },
  cc_prev: { en: 'Previous step', zh: '上一步' },
  cc_next: { en: 'Next step', zh: '下一步' },
  cc_refresh: { en: 'Refresh positions', zh: '刷新位置' },
  cc_expand_all: { en: 'Expand / collapse all', zh: '全部展开 / 折叠' },
  cc_open_editor: { en: 'Open in editor', zh: '在编辑器中打开' },
  cc_find_refs: { en: 'Find references', zh: '查找引用' },
  cc_copy_path: { en: 'Copy symbol path', zh: '复制符号路径' },
  cc_regen: { en: 'Regenerate this chain', zh: '重新生成这条链' },
  cc_regenerate: { en: 'Regenerate', zh: '重新生成' },
  cc_unresolved: { en: 'unresolved', zh: '未解析' },
  cc_ambiguous: { en: 'ambiguous', zh: '有歧义' },
  cc_stale: { en: 'stale', zh: '已失效' },
  cc_edge: { en: 'edge', zh: '边' },
  cc_implementations: { en: (n: number) => `${n} implementations`, zh: (n: number) => `${n} 个实现` },
  cc_candidates: { en: 'Candidates — click to pin', zh: '候选位置 — 点击选定' },
  cc_empty: { en: 'No chain loaded', zh: '尚未加载代码链' },
  cc_provenance_call: { en: 'call graph', zh: '调用图谱' },
  cc_provenance_type: { en: 'type graph', zh: '类型图谱' },
  cc_provenance_refs: { en: 'references', zh: '引用' },
} satisfies Record<string, Entry>;

export type SharedI18nKey = keyof typeof DICT;

/** Read the host-injected display language; falls back to English. */
export function sharedLanguage(): 'en' | 'zh' {
	if (typeof document === 'undefined') return 'en';
	const tag = document.querySelector('meta[name="vscode-language"]')?.getAttribute('content') ?? '';
	return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function t(key: SharedI18nKey, ...args: number[]): string {
	const entry = DICT[key];
	const value = entry[sharedLanguage()];
	return typeof value === 'function'
		? (value as (...a: number[]) => string)(...args)
		: value;
}