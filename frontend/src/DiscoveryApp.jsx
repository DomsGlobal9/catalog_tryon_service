import { useState, useEffect, useMemo } from 'react';
import { getTaxonomy, searchDesigns, DISCOVERY_BASE } from './discoveryApi';

const SHOT_TYPES = ['any', 'flatlay', 'worn'];

const EXAMPLES = [
  { label: 'Pastel green organza pallu',
    mode: 'nl', instruction: 'i need pastel green organza saree pallu designs for a reception' },
  { label: 'Red bridal kanjivaram pallu',
    mode: 'nl', instruction: 'I want red bridal kanjivaram saree pallu designs with heavy zari' },
  { label: 'Category + instruction (scoping)',
    mode: 'nl', instruction: 'heavy zari border in deep red', category: 'LEHANGA' },
  { label: 'Explicit beats parsed',
    mode: 'nl', instruction: 'red lehenga border', category: 'SAREE' },
  { label: 'Dupatta tassels (best component result)',
    mode: 'structured', category: 'DUPATTA', designType: 'TASSEL', keywords: 'gold' },
  { label: 'Broad keyword search',
    mode: 'structured', keywords: 'red, bridal, saree' },
  { label: 'Invalid pair → 400',
    mode: 'structured', category: 'SAREE', designType: 'SLEEVE', keywords: 'red' }
];

export default function DiscoveryApp() {
  const [taxonomy, setTaxonomy] = useState(null);
  const [taxonomyError, setTaxonomyError] = useState(null);
  const [showTree, setShowTree] = useState(false);

  const [mode, setMode] = useState('structured');
  const [category, setCategory] = useState('');
  const [designType, setDesignType] = useState('');
  const [keywords, setKeywords] = useState('red, bridal');
  const [instruction, setInstruction] = useState(
    'i need pastel green organza saree pallu designs for a reception'
  );
  const [color, setColor] = useState('');
  const [fabric, setFabric] = useState('');
  const [occasion, setOccasion] = useState('');
  const [shotType, setShotType] = useState('any');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getTaxonomy().then(setTaxonomy).catch(setTaxonomyError);
  }, []);

  const areas = useMemo(() => {
    if (!taxonomy || !category) return [];
    const g = taxonomy.garments.find((x) => x.id === category);
    return g ? g.designTypes : [];
  }, [taxonomy, category]);

  // A design area is only valid inside its garment, so changing garment clears it.
  useEffect(() => { setDesignType(''); }, [category]);

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
    return payload;
  }

  async function run(overridePage) {
    setLoading(true);
    setError(null);
    if (overridePage !== undefined) setPage(overridePage);
    try {
      setResult(await searchDesigns(buildPayload(overridePage)));
    } catch (err) {
      setError(err);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function applyExample(ex) {
    setMode(ex.mode);
    setCategory(ex.category || '');
    setKeywords(ex.keywords || '');
    setInstruction(ex.instruction || '');
    setColor(''); setFabric(''); setOccasion('');
    setShotType('any'); setPage(1);
    setResult(null); setError(null);
    // designType depends on category, which the effect above clears - set it after.
    setTimeout(() => setDesignType(ex.designType || ''), 0);
  }

  const payloadPreview = JSON.stringify(buildPayload(), null, 2);

  return (
    <div className="disc-wrap">
      <header className="disc-header">
        <h1>Design Discovery</h1>
        <p className="disc-sub">
          Keyword, structured and natural-language search over{' '}
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
          <div className="disc-field disc-narrow"><label>limit</label><input type="number" min="1" max="50" value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></div>
        </div>

        <p className="disc-note">
          <strong>filters are search qualifiers, not guarantees.</strong> They are folded into the query
          sent to the search engine; returned images are not verified to actually be that colour or fabric.
        </p>

        <div className="disc-actions">
          <button className="disc-run" onClick={() => run(1)} disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
          <button className="disc-secondary" onClick={() => setShowTree(!showTree)}>
            {showTree ? 'Hide' : 'Browse'} taxonomy
          </button>
        </div>

        <details className="disc-payload">
          <summary>Request payload</summary>
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
          {Array.isArray(error.details) && (
            <ul>{error.details.map((d, i) => (
              <li key={i}>{typeof d === 'string' ? d : `${d.field}: ${d.message}`}</li>
            ))}</ul>
          )}
        </section>
      )}

      {result && (
        <>
          <section className="disc-card">
            <h3>Interpreted</h3>
            <div className="disc-interp">
              <Field k="category" v={result.interpreted.categoryName ? `${result.interpreted.category} (${result.interpreted.categoryName})` : '—'} />
              <Field k="designType" v={result.interpreted.designTypeName ? `${result.interpreted.designType} (${result.interpreted.designTypeName})` : '—'} />
              <Field k="keywords" v={result.interpreted.keywords.join(', ') || '—'} />
              <Field k="source" v={result.interpreted.source} />
              <Field k="confidence" v={result.interpreted.confidence} />
              <Field k="unresolved" v={result.interpreted.unresolved.length ? result.interpreted.unresolved.join(', ') : '—'} />
            </div>
            <div className="disc-query">
              <span className="disc-label">query sent to the search engine</span>
              <code>{result.query}</code>
            </div>
            <div className="disc-meta">
              <span className={'disc-badge' + (result.cached ? ' cached' : '')}>
                {result.cached ? 'served from cache' : 'live provider call'}
              </span>
              <span>{result.results.length} results</span>
              <span>{result.elapsedMs} ms</span>
              <span>page {result.pagination.page} · limit {result.pagination.limit}</span>
              <span>hasMore: {String(result.pagination.hasMore)}</span>
              <span className="disc-hint">searchId {result.searchId.slice(0, 8)}…</span>
            </div>
            <div className="disc-actions">
              <button className="disc-secondary" disabled={loading || result.pagination.page <= 1} onClick={() => run(result.pagination.page - 1)}>← Prev page</button>
              <button className="disc-secondary" disabled={loading || !result.pagination.hasMore} onClick={() => run(result.pagination.page + 1)}>Next page →</button>
            </div>
          </section>

          <section className="disc-card">
            <h3>
              Results{' '}
              <span className="disc-hint">
                each is an individual image URL — the API never returns a composited sheet
                {result.results.some((r) => r.fetchable.from === 'thumbnailUrl') &&
                  ` · ${result.results.filter((r) => r.fetchable.from === 'thumbnailUrl').length} thumbnail-only (Instagram/Facebook)`}
              </span>
            </h3>
            {result.results.length === 0 ? (
              <p className="disc-hint">No results survived filtering for this query.</p>
            ) : (
              <div className="disc-results">
                {result.results.map((r) => (
                  <figure key={r.id} className="disc-result">
                    {/* Read `fetchable` and nothing else. The UI is a consumer of
                        the API contract, not of provider-specific behaviour, so it
                        never inspects imageUsable or picks a URL itself. */}
                    <img src={r.fetchable.url} alt={r.title || ''} loading="lazy" />
                    <figcaption>
                      <div className="disc-title">{r.title || '(untitled)'}</div>
                      <div className="disc-hint">
                        {r.sourceDomain} · {r.fetchable.width || '?'}×{r.fetchable.height || '?'}
                      </div>
                      {r.fetchable.from === 'thumbnailUrl' && (
                        <div className="disc-thumbonly" title={`Only the thumbnail is retrievable. The source reports the original as ${r.width}×${r.height}, but that asset cannot be fetched.`}>
                          thumbnail only · original {r.width}×{r.height}
                        </div>
                      )}
                      <div className="disc-links">
                        <a href={r.fetchable.url} target="_blank" rel="noreferrer noopener">image</a>
                        {r.sourceUrl && <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener">source</a>}
                        <button onClick={() => navigator.clipboard?.writeText(r.fetchable.url)}>copy URL</button>
                      </div>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>

          <details className="disc-card disc-payload">
            <summary>Raw JSON response</summary>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
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
