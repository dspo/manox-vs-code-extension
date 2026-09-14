// Minimal Markdown → HTML renderer for assistant text. Safe by construction:
// every text fragment is HTML-escaped before tag assembly, and the only
// emitted attributes are class names and http(s) hrefs — model output can
// never inject markup. Covers the chat-relevant subset: fenced code, inline
// code, bold/italic, links, headings, lists, blockquotes, hr, paragraphs.

const escapeHtml = (text: string): string =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

/** Inline spans: code, bold, italic, links. Escaped input, trusted output. */
function renderInline(text: string): string {
	const escaped = escapeHtml(text);
	return escaped
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" title="$2">$1</a>');
}

/** Absolute http(s) URLs on their own line become clickable links. */
function renderBareLink(text: string): string {
	return text.replace(/(^|[\s])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" title="$2">$2</a>');
}

export function renderMarkdown(source: string): string {
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	let paragraph: string[] = [];
	let listItems: string[] = [];
	let listOrdered = false;
	let quoteItems: string[] = [];

	const flushParagraph = (): void => {
		if (paragraph.length > 0) {
			const inline = renderInline(paragraph.join('\n')).replace(/\n/g, '<br>');
			out.push(`<p>${renderBareLink(inline)}</p>`);
			paragraph = [];
		}
	};
	const flushList = (): void => {
		if (listItems.length > 0) {
			const tag = listOrdered ? 'ol' : 'ul';
			out.push(`<${tag}>${listItems.map((li) => `<li>${renderInline(li)}</li>`).join('')}</${tag}>`);
			listItems = [];
		}
	};
	const flushQuote = (): void => {
		if (quoteItems.length > 0) {
			out.push(`<blockquote>${renderInline(quoteItems.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
			quoteItems = [];
		}
	};
	const flushAll = (): void => {
		flushParagraph();
		flushList();
		flushQuote();
	};

	let i = 0;
	while (i < lines.length) {
		const line = (lines[i] ?? '').trimEnd();

		const fence = /^\s*```(\w*)\s*$/.exec(line);
		if (fence) {
			flushAll();
			const lang = fence[1] ?? '';
			const body: string[] = [];
			let j = i + 1;
			while (j < lines.length && !/^\s*```\s*$/.test(lines[j] ?? '')) {
				body.push(lines[j] ?? '');
				j += 1;
			}
			out.push(
				`<pre class="code${lang ? ` lang-${escapeHtml(lang)}` : ''}"><code>${escapeHtml(body.join('\n'))}</code></pre>`,
			);
			i = j < lines.length ? j + 1 : j;
			continue;
		}

		if (line.trim() === '') {
			flushAll();
			i += 1;
			continue;
		}
		const heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading && heading[2] !== undefined) {
			flushAll();
			const level = (heading[1] ?? '#').length;
			out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
			i += 1;
			continue;
		}
		if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
			flushAll();
			out.push('<hr>');
			i += 1;
			continue;
		}
		const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
		if (bullet && bullet[1] !== undefined) {
			flushParagraph();
			flushQuote();
			if (listItems.length === 0 || listOrdered) {
				flushList();
				listOrdered = false;
			}
			listItems.push(bullet[1]);
			i += 1;
			continue;
		}
		const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (ordered && ordered[1] !== undefined) {
			flushParagraph();
			flushQuote();
			if (listItems.length === 0 || !listOrdered) {
				flushList();
				listOrdered = true;
			}
			listItems.push(ordered[1]);
			i += 1;
			continue;
		}
		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (quote && quote[1] !== undefined) {
			flushParagraph();
			flushList();
			quoteItems.push(quote[1]);
			i += 1;
			continue;
		}
		flushList();
		flushQuote();
		paragraph.push(renderBareLink(line));
		i += 1;
	}
	flushAll();
	return out.join('\n');
}
