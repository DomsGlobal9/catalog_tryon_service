import { useState, useEffect, useMemo, useRef } from 'react';
import { getTaxonomy, searchDesigns, streamDesigns, DISCOVERY_BASE } from './discoveryApi';

const SHOT_TYPES = ['any', 'flatlay', 'worn'];
const ALL_SOURCES = ['web', 'pinterest', 'instagram', 'facebook'];
const SOURCE_LABEL = { web: 'Web', pinterest: 'Pinterest', instagram: 'Instagram', facebook: 'Facebook' };
const ORIENTATIONS = ['portrait', 'landscape', 'square'];

const EXAMPLES = [
  { label: 'All 4 platforms: red bridal saree',
    mode: 'structured', keywords: 'red, bridal, saree', sources: ALL_SOURCES },
  { label: 'Pinterest + Instagram: blouse back',
    mode: 'nl', instruction: 'gold zari blouse back neck designs', sources: ['pinterest', 'instagram'] },
  { label: 'Full-size only (for generation)',
    mode: 'structured', category: 'SAREE', designType: 'PALLU', keywords: 'gold', sources: ALL_SOURCES,
    fullSizeOnly: true, minWidth: '600' },
  { label: 'Pastel green organza pallu',
    mode: 'nl', instruction: 'i need pastel green organza saree pallu designs for a reception', sources: ['web'] },
  { label: 'Category + instruction (scoping)',
    mode: 'nl', instruction: 'heavy zari border in deep red', category: 'LEHANGA', sources: ['web'] },
  { label: 'Dupatta tassels (best component result)',
    mode: 'structured', category: 'DUPATTA', designType: 'TASSEL', keywords: 'gold', sources: ['web'] },
  { label: 'Invalid pair → 400',
    mode: 'structured', category: 'SAREE', designType: 'SLEEVE', keywords: 'red', sources: ['web'] }
];

export default function DiscoveryApp() {
  const [taxonomy, setTaxonomy] = useState(null);
  const [taxonomyError, setTaxonomyError] = useState(null);
  const [showTree, setShowTree] = useState(false);

  const [mode, setMode] = useState('structured');
  const [category, setCategory] = useState('');
  const [designType, setDesignType] = useState('');
  const [keywords, setKeywords] = useState('red, bridal, saree');
  const [instruction, setInstruction] = useState(
    'i need pastel green organza saree pallu designs for a reception'
  );
  const [color, setColor] = useState('');
  const [fabric, setFabric] = useState('');
  const [occasion, setOccasion] = useState('');
  const [shotType, setShotType] = useState('any');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  // Where to search, and filters the service GUARANTEES (checked on real data).
  const [sources, setSources] = useState(ALL_SOURCES);
  const [fullSizeOnly, setFullSizeOnly] = useState(false);
  const [minWidth, setMinWidth] = useState('');
  const [orientation, setOrientation] = useState('');
  const [excludeDomains, setExcludeDomains] = useState('');

  const [useStream, setUseStream] = useState(true);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [platformTab, setPlatformTab] = useState('all');

  // Each search gets a number. Events from an older search - one that was
  // cancelled or replaced - are ignored, so they can never write into the new one.
  const runRef = useRef(0);
  const abortRef = useRef(null);

  useEffect(() => {
    getTaxonomy().then(setTaxonomy).catch(setTaxonomyError);
    return () => abortRef.current && abortRef.current.abort();
  }, []);

  const areas = useMemo(() => {
    if (!taxonomy || !category) return [];
    const g = taxonomy.garments.find((x) => x.id === category);
    return g ? g.designTypes : [];
  }, [taxonomy, category]);

  // A design area is only valid inside its garment, so changing garment clears it.
  useEffect(() => { setDesignType(''); }, [category]);

  function toggleSource(s) {
    setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : ALL_SOURCES.filter((x) => x === s || prev.includes(x))));
  }

  function buildPayload(overridePage) {
    const payload = { clientId: 'frontend-discovery-test', page: overridePage ?? page, limit };

    if (mode === 'nl') {
      payload.instruction = instruction.trim();
      if (category) payload.category = category;          // demonstrates parser scoping
      if (designType) payload.designType = designType;
    } else {
      const list = keywords.split(',').map((k) => k.trim()).filter(Boolean);
      if (list.length) payload.keywords = list;
      if (category) payload.category = category;
      if (designType) payload.designType = designType;
    }

    const filters = {};
    if (color.trim()) filters.color = color.trim();
    if (fabric.trim()) filters.fabric = fabric.trim();
    if (occasion.trim()) filters.occasion = occasion.trim();
    if (Object.keys(filters).length) payload.filters = filters;

    payload.shotType = shotType;
    payload.sources = sources;

    const rf = {};
    if (fullSizeOnly) rf.fullSizeOnly = true;
    if (String(minWidth).trim()) rf.minWidth = Number(minWidth);
    if (orientation) rf.orientation = orientation;
    const ex = excludeDomains.split(',').map((d) => d.trim()).filter(Boolean);
    if (ex.length) rf.excludeDomains = ex;
    if (Object.keys(rf).length) payload.resultFilters = rf;

    return payload;
  }

  async function run(overridePage) {
    if (abortRef.current) abortRef.current.abort();
    const myRun = ++runRef.current;
    const payload = buildPayload(overridePage);
    if (overridePage !== undefined) setPage(overridePage);
    setError(null);
    setLoading(true);
    setPlatformTab('all');
    const started = performance.now();
    const isCurrent = () => runRef.current === myRun;

    if (!useStream) {
      try {
        const r = await searchDesigns(payload);
        if (!isCurrent()) return;
        setView({
          mode: 'json',
          searchId: r.searchId,
          interpreted: r.interpreted,
          page: r.pagination.page,
          limit: r.pagination.limit,
          sources: r.sources,
          results: r.results,
          done: true,
          status: r.sources.every((s) => s.status === 'ok') ? 'ok' : 'partial',
          cached: r.cached,
          hasMore: r.pagination.hasMore,
          firstResultMs: r.elapsedMs,
          elapsedMs: r.elapsedMs,
          events: []
        });
      } catch (err) {
        if (!isCurrent()) return;
        setError(err);
        setView(null);
      } finally {
        if (isCurrent()) setLoading(false);
      }
      return;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setView({
      mode: 'stream',
      searchId: null,
      interpreted: null,
      page: payload.page,
      limit: payload.limit,
      sources: payload.sources.map((s) => ({ source: s, status: 'searching' })),
      results: [],
      done: false,
      firstResultMs: null,
      events: []
    });

    const onEvent = (e) => {
      if (!isCurrent()) return;
      const at = Math.round(performance.now() - started);
      const logged = { at, type: e.type, source: e.source, status: e.status,
        results: e.results ? e.results.length : undefined, error: e.error && e.error.code };

      setView((v) => {
        if (!v) return v;
        const events = [...v.events, logged].slice(-40);
        if (e.type === 'start') {
          return { ...v, events, searchId: e.searchId, interpreted: e.interpreted,
            sources: e.sources.map((s) => ({ ...s, status: 'searching' })) };
        }
        if (e.type === 'source') {
          const { results, type, ...summary } = e;
          const got = results || [];
          return {
            ...v,
            events,
            sources: v.sources.map((s) => (s.source === e.source ? { ...s, ...summary, arrivedMs: at } : s)),
            results: got.length ? [...v.results, ...got] : v.results,
            firstResultMs: v.firstResultMs ?? (got.length ? at : null)
          };
        }
        if (e.type === 'done') {
          return {
            ...v,
            events,
            done: true,
            status: e.status,
            cached: e.cached,
            hasMore: e.hasMore,
            elapsedMs: at,
            sources: e.sources.map((s) => ({ ...(v.sources.find((x) => x.source === s.source) || {}), ...s }))
          };
        }
        if (e.type === 'error') return { ...v, events, done: true, status: 'failed', streamError: e.message };
        return { ...v, events };
      });
    };

    try {
      const outcome = await streamDesigns(payload, onEvent, ac.signal);
      if (outcome.aborted && isCurrent()) {
        setView((v) => (v && !v.done
          ? { ...v, done: true, status: 'cancelled',
              sources: v.sources.map((s) => (s.status === 'searching' ? { ...s, status: 'cancelled' } : s)) }
          : v));
      }
    } catch (err) {
      if (!isCurrent()) return;
      setError(err);
      setView(null);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      if (isCurrent()) setLoading(false);
    }
  }

  function cancel() {
    if (abortRef.current) abortRef.current.abort();
  }

  function applyExample(ex) {
    setMode(ex.mode);
    setCategory(ex.category || '');
    setKeywords(ex.keywords || '');
    setInstruction(ex.instruction || '');
    setColor(''); setFabric(''); setOccasion('');
    setShotType('any'); setPage(1);
    setSources(ex.sources || ALL_SOURCES);
    setFullSizeOnly(!!ex.fullSizeOnly);
    setMinWidth(ex.minWidth || '');
    setOrientation('');
    setExcludeDomains('');
    setView(null); setError(null);
    // designType depends on category, which the effect above clears - set it after.
    setTimeout(() => setDesignType(ex.designType || ''), 0);
  }

  const payloadPreview = JSON.stringify(buildPayload(), null, 2);

  const counts = useMemo(() => {
    const c = { all: 0, web: 0, pinterest: 0, instagram: 0, facebook: 0 };
    for (const r of (view && view.results) || []) {
      c.all++;
      c[r.platform] = (c[r.platform] || 0) + 1;
    }
    return c;
  }, [view]);

  const shown = view ? (platformTab === 'all' ? view.results : view.results.filter((r) => r.platform === platformTab)) : [];
  const busy = loading && view && !view.done;

  return (
    <div className="disc-wrap">
      <header className="disc-header">
        <h1>Design Discovery</h1>
        <p className="disc-sub">
          Search the web, Pinterest, Instagram and Facebook over{' '}
          {taxonomy ? `${taxonomy.garmentCount} garments / ${taxonomy.designAreaCount} design areas` : 'the taxonomy'}.
          <span className="disc-endpoint">{DISCOVERY_BASE}</span>
        </p>
      </header>

      {taxonomyError && (
        <div className="disc-error">
          <strong>Could not load taxonomy</strong>
          <div>{taxonomyError.message}</div>
        </div>
      )}

      <section className="disc-card">
        <div className="disc-examples">
          <span className="disc-label">Try:</span>
          {EXAMPLES.map((ex) => (
            <button key={ex.label} className="disc-chip" onClick={() => applyExample(ex)}>{ex.label}</button>
          ))}
        </div>

        <div className="disc-modes">
          {['structured', 'nl'].map((m) => (
            <button
              key={m}
              className={'disc-mode' + (mode === m ? ' active' : '')}
              onClick={() => setMode(m)}
            >
              {m === 'structured' ? 'Structured' : 'Natural language'}
            </button>
          ))}
        </div>

        {mode === 'nl' ? (
          <div className="disc-field">
            <label>instruction</label>
            <textarea
              rows={2}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. i need pastel green organza saree pallu designs for a reception"
            />
            <small>
              Optionally pin a category below — the parser then resolves the design area within it,
              even when the sentence names no garment.
            </small>
          </div>
        ) : (
          <div className="disc-field">
            <label>keywords <span className="disc-hint">comma separated, max 12</span></label>
            <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="red, bridal, kanjivaram" />
          </div>
        )}

        <div className="disc-field">
          <label>sources <span className="disc-hint">one search per platform, run at the same time</span></label>
          <div className="disc-sources">
            {ALL_SOURCES.map((s) => (
              <label key={s} className={'disc-source-toggle disc-plat-' + s + (sources.includes(s) ? ' on' : '')}>
                <input type="checkbox" checked={sources.includes(s)} onChange={() => toggleSource(s)} />
                {SOURCE_LABEL[s]}
              </label>
            ))}
          </div>
          {sources.length === 0 && <small className="disc-warn">Pick at least one platform.</small>}
        </div>

        <div className="disc-row">
          <div className="disc-field">
            <label>category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">— none —</option>
              {taxonomy && taxonomy.garments.map((g) => (
                <option key={g.id} value={g.id}>{g.name} ({g.id})</option>
              ))}
            </select>
          </div>

          <div className="disc-field">
            <label>designType <span className="disc-hint">{areas.length ? `${areas.length} areas` : 'pick a category'}</span></label>
            <select value={designType} onChange={(e) => setDesignType(e.target.value)} disabled={!areas.length}>
              <option value="">— none —</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
            </select>
          </div>

          <div className="disc-field">
            <label>shotType</label>
            <select value={shotType} onChange={(e) => setShotType(e.target.value)}>
              {SHOT_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className="disc-row">
          <div className="disc-field"><label>filters.color</label><input value={color} onChange={(e) => setColor(e.target.value)} placeholder="emerald" /></div>
          <div className="disc-field"><label>filters.fabric</label><input value={fabric} onChange={(e) => setFabric(e.target.value)} placeholder="velvet" /></div>
          <div className="disc-field"><label>filters.occasion</label><input value={occasion} onChange={(e) => setOccasion(e.target.value)} placeholder="reception" /></div>
          <div className="disc-field disc-narrow">
            <label>limit <span className="disc-hint">each</span></label>
            <input type="number" min="1" max="100" value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
          </div>
        </div>

        <p className="disc-note">
          <strong>filters.color / fabric / occasion are search words, not guarantees.</strong> They are added
          to the search; returned images are not checked to actually be that colour or fabric.
        </p>

        <div className="disc-subhead">Result filters <span className="disc-hint">checked on every result — guaranteed</span></div>
        <div className="disc-row">
          <label className="disc-check">
            <input type="checkbox" checked={fullSizeOnly} onChange={(e) => setFullSizeOnly(e.target.checked)} />
            full-size images only <span className="disc-hint">drops Instagram / Facebook previews</span>
          </label>
          <div className="disc-field disc-narrow">
            <label>minWidth</label>
            <input type="number" min="1" max="10000" value={minWidth} onChange={(e) => setMinWidth(e.target.value)} placeholder="600" />
          </div>
          <div className="disc-field">
            <label>orientation</label>
            <select value={orientation} onChange={(e) => setOrientation(e.target.value)}>
              <option value="">any</option>
              {ORIENTATIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div className="disc-field">
            <label>excludeDomains <span className="disc-hint">comma separated</span></label>
            <input value={excludeDomains} onChange={(e) => setExcludeDomains(e.target.value)} placeholder="amazon.in, meesho.com" />
          </div>
        </div>

        <div className="disc-actions">
          <button className="disc-run" onClick={() => run(1)} disabled={loading || sources.length === 0}>
            {loading ? 'Searching…' : 'Search'}
          </button>
          {busy && <button className="disc-secondary" onClick={cancel}>Cancel</button>}
          <label className="disc-check disc-streamtoggle">
            <input type="checkbox" checked={useStream} onChange={(e) => setUseStream(e.target.checked)} disabled={loading} />
            live stream (SSE) <span className="disc-hint">{useStream ? 'results appear per platform as each finishes' : 'waits for every platform, then answers once'}</span>
          </label>
          <button className="disc-secondary" onClick={() => setShowTree(!showTree)}>
            {showTree ? 'Hide' : 'Browse'} taxonomy
          </button>
        </div>

        <details className="disc-payload">
          <summary>Request payload → POST {useStream ? '/search/stream' : '/search'}</summary>
          <pre>{payloadPreview}</pre>
        </details>
      </section>

      {showTree && taxonomy && (
        <section className="disc-card">
          <h3>Taxonomy — {taxonomy.garmentCount} garments / {taxonomy.designAreaCount} design areas</h3>
          <div className="disc-tree">
            {taxonomy.garments.map((g) => (
              <div key={g.id} className="disc-tree-garment">
                <h4>{g.name} <span className="disc-hint">{g.id} · {g.designTypes.length}</span></h4>
                <div>
                  {g.designTypes.map((a) => (
                    <button
                      key={a.id}
                      className="disc-area"
                      title={`Search ${g.id} / ${a.id}`}
                      onClick={() => { setMode('structured'); setCategory(g.id); setTimeout(() => setDesignType(a.id), 0); }}
                    >
                      {a.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {error && (
        <section className="disc-card disc-error">
          <strong>HTTP {error.status} · {error.code}</strong>
          <div>{error.message}</div>
          {error.retryAfter && <div>Retry after {error.retryAfter}s.</div>}
          {Array.isArray(error.details) && (
            <ul>{error.details.map((d, i) => (
              <li key={i}>{typeof d === 'string' ? d : `${d.field}: ${d.message}`}</li>
            ))}</ul>
          )}
        </section>
      )}

      {view && (
        <>
          <section className="disc-card">
            <h3>
              Platforms{' '}
              <span className="disc-hint">
                {view.mode === 'stream' ? 'live stream' : 'single JSON response'}
                {view.firstResultMs != null && ` · first results after ${fmtMs(view.firstResultMs)}`}
                {view.done && view.elapsedMs != null && ` · all finished after ${fmtMs(view.elapsedMs)}`}
              </span>
            </h3>
            <div className="disc-source-grid">
              {view.sources.map((s) => <SourceStatus key={s.source} s={s} />)}
            </div>
            {view.streamError && <p className="disc-warn">{view.streamError}</p>}
            {view.status === 'cancelled' && <p className="disc-warn">Search cancelled — results so far are kept below.</p>}
          </section>

          <section className="disc-card">
            <h3>Interpreted</h3>
            {view.interpreted ? (
              <div className="disc-interp">
                <Field k="category" v={view.interpreted.categoryName ? `${view.interpreted.category} (${view.interpreted.categoryName})` : '—'} />
                <Field k="designType" v={view.interpreted.designTypeName ? `${view.interpreted.designType} (${view.interpreted.designTypeName})` : '—'} />
                <Field k="keywords" v={view.interpreted.keywords.join(', ') || '—'} />
                <Field k="source" v={view.interpreted.source} />
                <Field k="confidence" v={view.interpreted.confidence} />
                <Field k="unresolved" v={view.interpreted.unresolved.length ? view.interpreted.unresolved.join(', ') : '—'} />
              </div>
            ) : <p className="disc-hint">waiting for the service…</p>}
            <div className="disc-meta">
              {view.done && (
                <span className={'disc-badge' + (view.cached ? ' cached' : '')}>
                  {view.cached ? 'served from cache' : 'live provider calls'}
                </span>
              )}
              <span>page {view.page} · limit {view.limit} per platform</span>
              {view.done && <span>hasMore: {String(!!view.hasMore)}</span>}
              {view.searchId && <span className="disc-hint">searchId {view.searchId.slice(0, 8)}…</span>}
            </div>
            <div className="disc-actions">
              <button className="disc-secondary" disabled={loading || view.page <= 1} onClick={() => run(view.page - 1)}>← Prev page</button>
              <button className="disc-secondary" disabled={loading || !view.done || !view.hasMore} onClick={() => run(view.page + 1)}>Next page →</button>
            </div>
          </section>

          <section className="disc-card">
            <h3>
              Results{' '}
              <span className="disc-hint">
                each is an individual image URL — the API never returns a composited sheet
              </span>
            </h3>

            <div className="disc-tabs">
              {['all', ...ALL_SOURCES].map((p) => (
                <button
                  key={p}
                  className={'disc-tab' + (platformTab === p ? ' active' : '') + (p !== 'all' ? ' disc-plat-' + p : '')}
                  onClick={() => setPlatformTab(p)}
                  disabled={p !== 'all' && !counts[p]}
                >
                  {p === 'all' ? 'All' : SOURCE_LABEL[p]} <span>{counts[p] || 0}</span>
                </button>
              ))}
            </div>

            {shown.length === 0 ? (
              <p className="disc-hint">
                {!view.done ? 'Waiting for the first platform to answer…'
                  : view.results.length === 0 ? 'No results survived filtering for this search.'
                  : 'No results from this platform.'}
              </p>
            ) : (
              <div className="disc-results">
                {shown.map((r) => (
                  <figure key={r.id} className="disc-result">
                    {/* Read `fetchable` and nothing else. The UI is a consumer of
                        the API contract, not of provider-specific behaviour, so it
                        never inspects imageUsable or picks a URL itself. */}
                    <ResultImage fetchable={r.fetchable} alt={r.title || ''} />
                    <figcaption>
                      <div className="disc-card-top">
                        <span className={'disc-plat disc-plat-' + r.platform}>{SOURCE_LABEL[r.platform] || r.platform}</span>
                        {r.foundBy && r.foundBy !== r.platform && (
                          <span className="disc-hint" title="The platform search that found this result">via {SOURCE_LABEL[r.foundBy]} search</span>
                        )}
                      </div>
                      <div className="disc-title">{r.title || '(untitled)'}</div>
                      <div className="disc-hint">
                        {r.sourceDomain} ·{' '}
                        {r.fetchable.sizeExact === false
                          ? <span title="Pinterest serves this larger version; its exact size is not known until downloaded. It may be smaller.">~{r.fetchable.width || '?'}×{r.fetchable.height || '?'} est.</span>
                          : <>{r.fetchable.width || '?'}×{r.fetchable.height || '?'}</>}
                      </div>
                      {r.fetchable.from === 'thumbnailUrl' && (
                        <div className="disc-thumbonly" title={`Only the preview is retrievable. The source reports the original as ${r.width}×${r.height}, but that asset cannot be fetched.`}>
                          preview only · original {r.width}×{r.height}
                        </div>
                      )}
                      {r.fetchable.fallbackUrl && (
                        <div className="disc-upgraded" title={`Upgraded from ${r.width}×${r.height}. Original kept as fallback.`}>
                          upgraded from {r.width}px
                        </div>
                      )}
                      <div className="disc-links">
                        <a href={r.fetchable.url} target="_blank" rel="noreferrer noopener">image</a>
                        {r.sourceUrl && <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener">source</a>}
                        <CopyUrlButton url={r.fetchable.url} />
                      </div>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>

          {view.mode === 'stream' && (
            <details className="disc-card disc-payload">
              <summary>Stream events ({view.events.length})</summary>
              <pre>{view.events.map((e) =>
                `${String(e.at).padStart(6)}ms  ${e.type.padEnd(6)} ${e.source || ''} ${e.status || ''}` +
                `${e.results !== undefined ? ' results=' + e.results : ''}${e.error ? ' ' + e.error : ''}`
              ).join('\n')}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** One platform's live state: searching, finished (with what was kept), or failed. */
function SourceStatus({ s }) {
  const label = SOURCE_LABEL[s.source] || s.source;
  return (
    <div className={`disc-source disc-source-${s.status} disc-plat-${s.source}`}>
      <div className="disc-source-head">
        <span className="disc-dot" />
        <strong>{label}</strong>
        {s.status === 'searching' && <span className="disc-hint">searching…</span>}
        {s.status === 'ok' && <span>{s.returned} result{s.returned === 1 ? '' : 's'}</span>}
        {s.status === 'error' && <span className="disc-fail">failed</span>}
        {s.status === 'cancelled' && <span className="disc-hint">cancelled</span>}
      </div>
      {s.status === 'ok' && (
        <div className="disc-hint">
          {fmtMs(s.durationMs)}{s.cached ? ' · cache' : ''}
          {s.offPlatform ? ` · ${s.offPlatform} from other sites dropped` : ''}
          {s.duplicates ? ` · ${s.duplicates} duplicate${s.duplicates === 1 ? '' : 's'}` : ''}
          {s.removedByFilters ? ` · ${s.removedByFilters} removed by filters` : ''}
        </div>
      )}
      {s.status === 'error' && <div className="disc-hint">{s.error && s.error.message}</div>}
      {s.query && <code className="disc-source-query" title="Query sent for this platform">{s.query}</code>}
    </div>
  );
}

/**
 * Shows fetchable.url. If it fails and the service supplied a fallbackUrl (an
 * upgraded Pinterest image), falls back to the original smaller image instead of
 * leaving a broken picture.
 */
function ResultImage({ fetchable, alt }) {
  const [src, setSrc] = useState(fetchable.url);
  const [broken, setBroken] = useState(false);

  useEffect(() => { setSrc(fetchable.url); setBroken(false); }, [fetchable.url]);

  function onError() {
    if (fetchable.fallbackUrl && src !== fetchable.fallbackUrl) setSrc(fetchable.fallbackUrl);
    else setBroken(true);
  }

  if (broken) return <div className="disc-broken">image unavailable</div>;
  return <img src={src} alt={alt} loading="lazy" onError={onError} />;
}

/**
 * Copy-to-clipboard that actually tells the user what happened.
 *
 * `navigator.clipboard.writeText` returns a promise that REJECTS when the
 * document is not focused or the permission is denied. The previous inline
 * handler ignored that promise, so a denied copy was an uncaught rejection in
 * the console and, to the user, a button that did nothing at all. Both
 * outcomes are now reported, and on failure the URL is offered in the tooltip
 * so it can still be copied by hand.
 */
function CopyUrlButton({ url }) {
  const [state, setState] = useState('idle'); // idle | copied | failed

  async function copy() {
    let next = 'copied';
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(url);
    } catch {
      next = 'failed';
    }
    setState(next);
    setTimeout(() => setState('idle'), 2000);
  }

  return (
    <button
      onClick={copy}
      className={state === 'failed' ? 'disc-copy-failed' : undefined}
      title={state === 'failed' ? `Clipboard blocked by the browser. URL: ${url}` : url}
    >
      {state === 'copied' ? 'copied ✓' : state === 'failed' ? 'copy blocked' : 'copy URL'}
    </button>
  );
}

function Field({ k, v }) {
  return (
    <div className="disc-kv">
      <span className="disc-label">{k}</span>
      <span>{v}</span>
    </div>
  );
}
