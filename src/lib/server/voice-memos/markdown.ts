/**
 * VOICE-01: a deliberately small markdown → HTML renderer for digests.
 *
 * Escape-first: the whole input is HTML-escaped before any markup is added, so
 * nothing in a digest can inject tags or attributes. Links only to site paths
 * ("/kanban/task/…") or http(s) URLs. Supports what the digest tool description
 * promises: #/##/### headings, - / * bullets, 1. lists, **bold**, *italic*,
 * `code`, [text](href), paragraphs. Anything else renders as plain text.
 */

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function safeHref(href: string): string | null {
	// href is already escaped; &amp; in query strings is correct inside an attribute.
	if (/^\/(?!\/)/.test(href) || /^#[\w-]*$/.test(href)) return href;
	if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
	return null;
}

/** Inline markup over ALREADY-ESCAPED text. */
function inline(escaped: string): string {
	const codes: string[] = [];
	let s = escaped.replace(/`([^`]+)`/g, (_m, c: string) => {
		codes.push(c);
		return `\u0000${codes.length - 1}\u0000`;
	});

	s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, href: string) => {
		const ok = safeHref(href);
		if (!ok) return m;
		const external = ok.startsWith('http');
		return `<a href="${ok}" class="md-link"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
	});
	s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');

	return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code class="md-code">${codes[Number(i)]}</code>`);
}

export function renderDigestMarkdown(md: string): string {
	const lines = escapeHtml(md.replace(/\r\n?/g, '\n')).split('\n');
	const out: string[] = [];
	let para: string[] = [];
	let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;

	const flushPara = () => {
		if (para.length) out.push(`<p class="md-p">${para.map(inline).join('<br>')}</p>`);
		para = [];
	};
	const flushList = () => {
		if (list) out.push(`<${list.tag} class="md-${list.tag}">${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
		list = null;
	};

	for (const line of lines) {
		const heading = /^(#{1,3})\s+(.*)$/.exec(line);
		const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
		const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

		if (!line.trim()) {
			flushPara();
			flushList();
		} else if (heading) {
			flushPara();
			flushList();
			const level = heading[1].length;
			out.push(`<h${level + 2} class="md-h${level}">${inline(heading[2])}</h${level + 2}>`);
		} else if (bullet || ordered) {
			flushPara();
			const tag = bullet ? 'ul' : 'ol';
			if (list && list.tag !== tag) flushList();
			if (!list) list = { tag, items: [] };
			list.items.push((bullet ?? ordered)![1]);
		} else {
			flushList();
			para.push(line);
		}
	}
	flushPara();
	flushList();
	return out.join('\n');
}
