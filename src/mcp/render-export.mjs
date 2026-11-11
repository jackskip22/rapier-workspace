// SPDX-License-Identifier: AGPL-3.0-only
import {parseHTML, Node, HTMLInputElement} from 'linkedom/worker';
import sanitizeHtml from 'sanitize-html';

const QUIET = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
function quietSanitizeHtml(...args) {
  const kept = QUIET.map(name => console[name]);
  for (const name of QUIET) console[name] = () => {};
  try { return sanitizeHtml(...args); }
  finally { QUIET.forEach((name, at) => { console[name] = kept[at]; }); }
}
import {parseFragment, serialize} from 'parse5';
import markdownit from '../agent/vendor/markdownit.mjs';
import {markdownPlugins} from '../agent/markdown-plugins.mjs';
import * as markdownSpec from '../agent/markdown-spec.mjs';
import * as assets from '../images/assets.mjs';
import * as markdownLayout from '../layout/markdown.mjs';
import {_rapierColorForDarkPaper} from '../editor/colour-math.mjs';
import {_rapierHeadingSlugBase, _rapierNextHeadingSlug} from '../editor/source-facts.mjs';
import {createMarkdownRenderer} from '../kit/render-markdown.mjs';
import {createRenderSanitizer, createInertHtmlSanitizer} from '../kit/render-sanitize.mjs';
import {createRenderStyles} from '../kit/render-styles.mjs';
import {createRenderer} from '../kit/render.mjs';
import {exportFilename, exportFidelity} from '../agent/kernel.mjs';
import {VERSION} from '../version.mjs';
import {configureExportRenderer} from './export-port.mjs';
import {styles} from './render-assets.mjs';

Object.defineProperty(HTMLInputElement.prototype, 'checked', {
  configurable: true,
  get() { return this.hasAttribute('checked'); },
  set(value) { if (value) this.setAttribute('checked', ''); else this.removeAttribute('checked'); },
});

export const RENDER_LIMITS = Object.freeze({sourceBytes: 256 * 1024, tokens: 30000});
const encoder = new TextEncoder();
const overLimit = () => Object.assign(new Error('export_render_limit'), {code: 'export_render_limit'});
const admitBytes = source => {
  if (source.length > RENDER_LIMITS.sourceBytes || encoder.encode(source).byteLength > RENDER_LIMITS.sourceBytes) throw overLimit();
};
const admitTokens = (parser, document) => {
  if (document.metadata.docKind === 'markdown' && parser.parse(document.canonical, {}).length > RENDER_LIMITS.tokens) throw overLimit();
};

function capture(source, options, format) {
  if (typeof source !== 'string') throw new TypeError('Document source must be a string');
  const filename = options.filename || 'document.md';
  if (typeof filename !== 'string' || !filename.trim() || /[\\/\u0000-\u001f\u007f]/.test(filename))
    throw new TypeError('Invalid document filename');
  const baseName = filename.replace(/\.[a-z0-9]+$/i, '') || 'document';
  const name = exportFilename(filename, format);
  return {canonical: source.charCodeAt(0) === 0xfeff ? source.slice(1) : source,
    baseName, name, metadata: {filename, docKind: options.docKind || 'markdown', codeLang: options.codeLang || ''}};
}

function realm() {
  const {document} = parseHTML('<!doctype html><html><head><meta name="rapier-version" content="' + VERSION + '"></head><body></body></html>');
  const scope = {
    document, Node, crypto: globalThis.crypto, URL, location: new URL('https://rapier.invalid/'),
    markdownit, ...markdownPlugins,
    RapierMarkdownSpec: markdownSpec, RapierMarkdownLayout: markdownLayout, RapierImageAssets: assets,
    RAPIER_MARKDOWN_SPEC: markdownSpec.RAPIER_MARKDOWN_SPEC,
    RAPIER_HIGHLIGHT_COLOR_BY_MARKER: Object.fromEntries(Object.entries(markdownSpec.RAPIER_HIGHLIGHT_COLORS).map(([color, marker]) => [marker, color])),
    RAPIER_RENDERED_HEADING_SELECTOR: 'h1, h2, h3, h4, h5, h6',
    RAPIER_RASTER_DATA_URL_RE: /^data:(image\/(?:png|jpeg|webp|jxl|svg\+xml));base64,([a-z0-9+/]+={0,2})$/i,
    _rapierApplyMarkdownSpec: markdownSpec.applyMarkdownSpec,
    _rapierInstallMarkdownMath: markdownSpec.installMarkdownMath,
    _rapierSplitOpeningFrontmatter: markdownSpec.splitOpeningFrontmatter,
    _rapierSourceCharEscaped: markdownSpec.sourceCharEscaped,
    _rapierHeadingSlugBase, _rapierNextHeadingSlug,
    _rapierDeriveDarkColor: _rapierColorForDarkPaper,
    _rapierDormantHeadings: (root, selector, includeLive) => includeLive ? Array.from(root.querySelectorAll(selector)) : [],
    _rapierRenderedAnchorOriginalIds: new WeakMap(),
    _rapierPlainLayout: () => false, _rapierHighlightAdmitted: () => false,
    _rapierProviders: {math: null, mermaid: null}, _rapierRemoteContent: {allowed: true},
    _rapierSanitizeRuntime: {context: 'render', chromeIds: new Set()},
    _rapierArtifactAccent: () => '#12A594', _rapierStyleText: id => styles[id] || '',
    _rapierArtifactPreference: name => ({theme: 'system', highlights: 'standard'})[name],
    _rapierPrefixPortableAnchors: (...args) => writer._rapierPrefixPortableAnchors(...args),
  };
  scope.globalThis = scope; scope.window = scope;
  const sanitizer = createRenderSanitizer(scope);
  Object.assign(scope, sanitizer);
  scope.sanitizeRapierHtml = createInertHtmlSanitizer({parseFragment, serialize, sanitizeHtml: quietSanitizeHtml,
    safeRasterDataUrl: sanitizer._rapierSafeRasterDataUrl});
  Object.assign(scope, createRenderStyles(scope));
  const markdown = createMarkdownRenderer(scope);
  markdown.initMarkdownIt();
  scope.md = markdown.parser();
  Object.assign(scope, markdown);
  const writer = createRenderer(scope);
  return {markdown, writer, parser: scope.md};
}

export async function renderText(source, options = {}) {
  const document = capture(source, options, 'txt');
  const semantic = document.metadata.docKind === 'markdown';
  if (semantic) admitBytes(document.canonical);
  const {markdown, parser} = realm();
  if (semantic) admitTokens(parser, document);
  const semanticRoot = semantic ? markdown._rapierRenderSemanticRoot(document.canonical, document.metadata) : null;
  return {text: markdown._rapierPlainTextFile({...document, semanticRoot}), filename: document.name, fidelity: exportFidelity('txt')};
}

export function configureHostedExportRenderer() {
  configureExportRenderer({renderText});
}
