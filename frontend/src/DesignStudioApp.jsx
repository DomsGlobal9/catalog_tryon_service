import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { getOptions, generateGarment, cancelGarment, DESIGNSTUDIO_BASE } from './designStudioApi';
import './designstudio.css';

// =============================================================================
// DesignStudioApp — test harness for POST /api/v1/designstudio/generate
// =============================================================================
//
// What this screen is for: attaching the same things a third party would send -
// design pictures per area, fabric swatches with their colours, optionally a
// model photo - and watching the exact payload that leaves the browser, then the
// exact events that come back.
//
// Two things are deliberate:
//   1. The payload is shown before it is sent, with the base64 shortened, so you
//      can check field for field that the backend receives what you meant.
//   2. Nothing is silently corrected. A missing image, a non-Cloudinary link or
//      two main fabrics are flagged as warnings but still sent, so the service's
//      own refusals (400 VALIDATION_ERROR, 422 IMAGE_UNUSABLE) can be tested
//      from here too.
//
// Pickers are built from GET /options, never hard-coded, so the 12 garments and
// their 107 design areas stay in step with the service.

const CLOUDINARY = /^https:\/\/res(-\d+)?\.cloudinary\.com\/.+/i;

// Only garment + areas + a style hint. The pictures are yours to attach.
const PRESETS = [
  { label: 'Saree', garment: 'SAREE', areas: ['PALLU', 'BORDER', 'BODY'],
    productName: 'Bridal Banarasi Saree', notes: 'luxury boutique catalogue look' },
  { label: 'Lehenga', garment: 'LEHANGA', areas: ['SKIRT', 'BORDER', 'WAISTBAND'],
    productName: 'Rust Mirror-work Lehenga', notes: 'festive look' },
  { label: 'Kurti', garment: 'KURTHI', areas: ['NECK', 'HEMLINE', 'SLEEVE'],
    productName: 'Mint Chikankari Kurti', notes: 'clean daywear catalogue look' },
  { label: 'Gown', garment: 'GOWN', areas: ['NECK', 'SKIRT_FLARE', 'BORDER_HEM'],
    productName: 'Black Beaded Evening Gown', notes: 'evening wear, soft studio light' },
  { label: 'Blouse (waist-up)', garment: 'BLOUSE', areas: ['NECK', 'SLEEVE'],
    productName: 'Chikankari Blouse', notes: 'clean boutique catalogue look' },
  { label: 'Blouse back', garment: 'BLOUSE', areas: ['BACK'],
    productName: 'Zari Back Blouse', notes: 'the back is the hero' },
  { label: 'Dupatta (three-quarter)', garment: 'DUPATTA', areas: ['BORDER', 'PALLU_END', 'TASSEL'],
    productName: 'Organza Dupatta', notes: 'soft, airy drape' }
];

// Cloudinary's public demo account, so the https path can be exercised with no
// uploads at all. The colorize transform makes an exact-colour fabric swatch.
const DEMO_LINKS = [
  { label: 'demo: plain wine swatch',
    url: 'https://res.cloudinary.com/demo/image/upload/w_900,h_900,c_fill,e_colorize:100,co_rgb:722F37/sample.jpg' },
  { label: 'demo: sample.jpg', url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' },
  { label: 'refusal: not Cloudinary', url: 'https://i.pinimg.com/736x/a.jpg' },
  { label: 'refusal: missing file', url: 'https://res.cloudinary.com/demo/image/upload/nope-9f8e7d.jpg' }
];

let seq = 1;
const rowId = () => `row-${seq++}`;

const blankDesign = () => ({
  id: rowId(), area: '', image: null, note: '',
  groundColor: '', groundColorHex: '', keepMotifColors: true, coverage: 'full', advanced: false
});
const blankFabric = () => ({
  id: rowId(), image: null, name: '', material: '', color: '', colorHex: '',
  itemCode: '', quantityMeters: '', note: '', appliesTo: []
});

const clean = (s) => (typeof s === 'string' ? s.trim() : '');
const hexish = (s) => /^#?[0-9a-fA-F]{6}$/.test(clean(s));
// Normalised when it is a real hex, sent as typed when it is not, so a bad value
// reaches the service and comes back as a named 400 instead of vanishing here.
const asHex = (s) => (hexish(s) ? `#${clean(s).replace('#', '').toUpperCase()}` : clean(s));
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`);
const imageValue = (slot) => (!slot ? '' : slot.mode === 'url' ? clean(slot.url) : slot.dataUrl || '');
const hasImage = (slot) => imageValue(slot).length > 0;

/** Read a picked file into a data URI, and measure it so limits can be checked here. */
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onloadend = () => {
      const dataUrl = String(reader.result || '');
      const probe = new Image();
      // HEIC cannot be decoded by the browser, so width stays 0; the service
      // still accepts it. Never fail the pick over a missing preview.
      probe.onload = () => resolve({
        mode: 'file', dataUrl, url: '', fileName: file.name, bytes: file.size,
        width: probe.naturalWidth, height: probe.naturalHeight
      });
      probe.onerror = () => resolve({
        mode: 'file', dataUrl, url: '', fileName: file.name, bytes: file.size, width: 0, height: 0
      });
      probe.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

/** Shorten every base64 in a payload so the preview stays readable. */
function shortenImages(value) {
  if (typeof value === 'string') {
    return value.startsWith('data:') && value.length > 120
      ? `${value.slice(0, 48)}…(${kb(Math.round((value.length * 3) / 4))} of base64)`
      : value;
  }
  if (Array.isArray(value)) return value.map(shortenImages);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shortenImages(v);
    return out;
  }
  return value;
}

export default function DesignStudioApp() {
  const [options, setOptions] = useState(null);
  const [optionsError, setOptionsError] = useState(null);

  const [clientId, setClientId] = useState('frontend-designstudio-test');
  const [garment, setGarment] = useState('SAREE');
  const [productName, setProductName] = useState('Bridal Banarasi Saree');
  const [notes, setNotes] = useState('luxury boutique catalogue look');
  const [shape, setShape] = useState('canonical'); // or 'catalogue' - the alias spelling

  const [designs, setDesigns] = useState([blankDesign()]);
  const [fabrics, setFabrics] = useState([blankFabric()]);

  const [modelKind, setModelKind] = useState('generated');
  const [modelImage, setModelImage] = useState(null);
  const [modelGender, setModelGender] = useState('');

  // pairWith: the supporting piece worn with the product (a saree's blouse).
  const [pairColor, setPairColor] = useState('');
  const [pairColorHex, setPairColorHex] = useState('');
  const [pairNote, setPairNote] = useState('');

  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState([]);
  const [startInfo, setStartInfo] = useState(null);
  const [brief, setBrief] = useState(null);
  const [image, setImage] = useState(null);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const [keepalives, setKeepalives] = useState(0);
  const [cancelNote, setCancelNote] = useState(null);
  const [blobUrl, setBlobUrl] = useState(null);

  const runRef = useRef(0);
  const abortRef = useRef(null);
  const clientIdRef = useRef(clientId);
  clientIdRef.current = clientId;

  useEffect(() => {
    getOptions().then(setOptions).catch(setOptionsError);
  }, []);

  // A generation left running on the service holds a capacity slot, so a closed
  // tab or a left page must stop it - exactly as a real integration should.
  useEffect(() => {
    const stop = () => cancelGarment(clientIdRef.current);
    window.addEventListener('beforeunload', stop);
    return () => {
      window.removeEventListener('beforeunload', stop);
      if (abortRef.current) abortRef.current.abort();
      stop();
    };
  }, []);

  // A downloadable, openable URL for the returned base64.
  useEffect(() => {
    if (!image || !image.image) { setBlobUrl(null); return undefined; }
    const base64 = image.image.slice(image.image.indexOf(',') + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType || 'image/jpeg' }));
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  // Stable identities: these feed the payload and pre-flight memos, which must
  // not recompute over multi-megabyte base64 on every keystroke.
  const garments = useMemo(() => (options && options.garments) || [], [options]);
  const current = useMemo(() => garments.find((g) => g.id === garment) || null, [garments, garment]);
  const areas = useMemo(() => (current ? current.designAreas : []), [current]);
  const limits = useMemo(
    () => (options && options.limits) || { maxDesigns: 6, maxFabrics: 3, maxImageMb: 12, maxRequestMb: 50 },
    [options]
  );

  // Changing garment invalidates every area, so designs and fabric assignments reset.
  function pickGarment(id) {
    setGarment(id);
    setDesigns((prev) => prev.map((d) => ({ ...d, area: '' })));
    setFabrics((prev) => prev.map((f) => ({ ...f, appliesTo: [] })));
  }

  function applyPreset(preset) {
    setGarment(preset.garment);
    setProductName(preset.productName);
    setNotes(preset.notes);
    setDesigns((prev) => {
      // Keep any pictures already attached, in order, and re-label the areas.
      const kept = prev.filter((d) => hasImage(d.image));
      const rows = preset.areas.map((area, i) => ({
        ...(kept[i] || blankDesign()), id: kept[i] ? kept[i].id : rowId(), area
      }));
      return rows;
    });
    setFabrics((prev) => prev.map((f) => ({ ...f, appliesTo: [] })));
  }

  const updateDesign = (id, patch) => setDesigns((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const updateFabric = (id, patch) => setFabrics((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  function toggleApplies(id, areaId) {
    setFabrics((prev) => prev.map((f) => {
      if (f.id !== id) return f;
      const has = f.appliesTo.includes(areaId);
      return { ...f, appliesTo: has ? f.appliesTo.filter((a) => a !== areaId) : [...f.appliesTo, areaId] };
    }));
  }

  // ── The payload ────────────────────────────────────────────────────────────
  //
  // Optional fields are left out entirely when blank, so the service receives a
  // clean request rather than a pile of empty strings.
  const buildPayload = useCallback(() => {
    const rows = designs.filter((d) => hasImage(d.image) || d.area);
    const fabricRows = fabrics.filter((f) => hasImage(f.image) || f.name || f.color || f.colorHex || f.itemCode);
    const catalogue = shape === 'catalogue';
    const payload = { clientId: clean(clientId) };

    if (catalogue) payload.productType = garment; else payload.garment = garment;
    if (clean(productName)) payload.productName = clean(productName);
    if (clean(notes)) payload[catalogue ? 'instructions' : 'notes'] = clean(notes);

    const designList = rows.map((d) => {
      const areaName = (areas.find((a) => a.id === d.area) || {}).name;
      const entry = catalogue
        ? { type: d.area, designImageUrl: imageValue(d.image) }
        : { area: d.area, image: imageValue(d.image) };
      if (catalogue && areaName) entry.label = areaName;
      if (clean(d.note)) entry[catalogue ? 'description' : 'note'] = clean(d.note);
      if (clean(d.groundColor)) entry[catalogue ? 'groundColour' : 'groundColor'] = clean(d.groundColor);
      if (clean(d.groundColorHex)) entry[catalogue ? 'groundColourHex' : 'groundColorHex'] = asHex(d.groundColorHex);
      // Defaults are true / 'full'; only a change is worth sending.
      if (d.keepMotifColors === false) entry[catalogue ? 'keepMotifColours' : 'keepMotifColors'] = false;
      if (d.coverage === 'reference') entry.coverage = 'reference';
      return entry;
    });
    payload[catalogue ? 'parts' : 'designs'] = designList;

    if (fabricRows.length) {
      payload.fabrics = fabricRows.map((f) => {
        const entry = catalogue ? { imageUrl: imageValue(f.image) } : { image: imageValue(f.image) };
        const fields = {};
        if (clean(f.name)) fields.name = clean(f.name);
        if (clean(f.material)) fields.material = clean(f.material);
        if (clean(f.color)) fields[catalogue ? 'colour' : 'color'] = clean(f.color);
        if (clean(f.colorHex)) fields.colorHex = asHex(f.colorHex);
        if (clean(f.itemCode)) fields.itemCode = clean(f.itemCode);
        if (catalogue && clean(f.quantityMeters) !== '' && Number.isFinite(Number(f.quantityMeters))) {
          fields.quantityMeters = Number(f.quantityMeters); // accepted, then ignored
        }
        if (catalogue) {
          if (Object.keys(fields).length) entry.details = fields;
        } else {
          Object.assign(entry, fields);
        }
        if (clean(f.note)) entry.note = clean(f.note);
        // No appliesTo means "the main fabric": everything without its own.
        if (f.appliesTo.length) entry.appliesTo = f.appliesTo;
        return entry;
      });
    }

    if (modelKind === 'reference' && hasImage(modelImage)) {
      payload[catalogue ? 'modelImageUrl' : 'modelImage'] = imageValue(modelImage);
    }
    if (modelGender) payload.modelGender = modelGender;

    const pair = {};
    if (clean(pairColor)) pair[catalogue ? 'colour' : 'color'] = clean(pairColor);
    if (clean(pairColorHex)) pair.colorHex = asHex(pairColorHex);
    if (clean(pairNote)) pair.note = clean(pairNote);
    if (Object.keys(pair).length) payload.pairWith = pair;
    return payload;
  }, [clientId, garment, productName, notes, shape, designs, fabrics, modelKind, modelImage, modelGender,
    pairColor, pairColorHex, pairNote, areas]);

  // Built once per change, not once per render: a few megabytes of base64 must
  // not be stringified again every time a checkbox moves.
  const payload = useMemo(() => buildPayload(), [buildPayload]);
  const payloadBytes = useMemo(() => new Blob([JSON.stringify(payload)]).size, [payload]);
  const preview = useMemo(() => JSON.stringify(shortenImages(payload), null, 2), [payload]);

  // ── What the service will say before it is asked ────────────────────────────
  const checks = useMemo(() => {
    const list = [];
    const block = (text) => list.push({ level: 'block', text });
    const warn = (text) => list.push({ level: 'warn', text });

    if (!clean(clientId)) block('clientId is required (it is also what /cancel stops).');
    if (!garment) block('Pick a garment.');
    const usable = designs.filter((d) => hasImage(d.image));
    if (!usable.length) block('Attach at least one design picture.');

    designs.forEach((d, i) => {
      const filled = hasImage(d.image) || d.area;
      if (!filled) return;
      if (!d.area) warn(`Design ${i + 1} has no area — the service will refuse designs[${i}].area.`);
      if (!hasImage(d.image)) warn(`Design ${i + 1} has no picture — the service will refuse designs[${i}].image.`);
      if (d.image && d.image.mode === 'url' && clean(d.image.url) && !CLOUDINARY.test(clean(d.image.url))) {
        warn(`Design ${i + 1}'s link is not on res.cloudinary.com — expect 400 IMAGE_SOURCE_NOT_ALLOWED.`);
      }
      if (d.image && d.image.bytes > limits.maxImageMb * 1024 * 1024) {
        warn(`Design ${i + 1} is ${kb(d.image.bytes)} — over the ${limits.maxImageMb} MB per-image limit.`);
      }
      const edge = d.image ? Math.max(d.image.width, d.image.height) : 0;
      if (edge && edge < 64) warn(`Design ${i + 1} is only ${edge}px — under 64px is refused.`);
      else if (edge && edge < 512) warn(`Design ${i + 1} is only ${edge}px — under 512px loses fine detail (the service warns too).`);
      if (clean(d.groundColorHex) && !hexish(d.groundColorHex)) {
        warn(`Design ${i + 1}'s ground hex is not a 6-digit colour — expect a named 400.`);
      }
    });

    const areaIds = usable.map((d) => d.area).filter(Boolean);
    const dupes = areaIds.filter((a, i) => areaIds.indexOf(a) !== i);
    if (dupes.length) warn(`Two designs are for ${[...new Set(dupes)].join(', ')} — expect DUPLICATE_DESIGN_AREA.`);
    if (usable.length > limits.maxDesigns) warn(`${usable.length} designs — the limit is ${limits.maxDesigns}.`);

    const sent = fabrics.filter((f) => hasImage(f.image) || f.name || f.color || f.colorHex || f.itemCode);
    sent.forEach((f, i) => {
      if (!hasImage(f.image)) warn(`Fabric ${i + 1} has no picture — the service will refuse fabrics[${i}].image.`);
      if (f.image && f.image.mode === 'url' && clean(f.image.url) && !CLOUDINARY.test(clean(f.image.url))) {
        warn(`Fabric ${i + 1}'s link is not on res.cloudinary.com — expect 400 IMAGE_SOURCE_NOT_ALLOWED.`);
      }
      if (clean(f.colorHex) && !hexish(f.colorHex)) warn(`Fabric ${i + 1}'s hex is not a 6-digit colour — expect a named 400.`);
    });
    const mains = sent.filter((f) => !f.appliesTo.length);
    if (mains.length > 1) warn(`${mains.length} fabrics have no "applies to" — expect MULTIPLE_MAIN_FABRICS. Only one fabric can be the main one.`);
    const claimed = new Map();
    sent.forEach((f, i) => f.appliesTo.forEach((a) => {
      if (claimed.has(a)) warn(`Fabrics ${claimed.get(a)} and ${i + 1} both cover ${a} — expect FABRIC_AREA_CONFLICT.`);
      else claimed.set(a, i + 1);
    }));
    if (sent.length > limits.maxFabrics) warn(`${sent.length} fabrics — the limit is ${limits.maxFabrics}.`);

    const pairSent = clean(pairColor) || clean(pairColorHex) || clean(pairNote);
    if (pairSent && current && current.pairedWith === null) {
      warn(`A ${current.name.toLowerCase()} is the whole outfit, so pairWith will not be used (the service says so in start.warnings).`);
    }
    if (clean(pairColorHex) && !hexish(pairColorHex)) warn('The pairWith hex is not a 6-digit colour — expect a named 400.');

    if (modelKind === 'reference' && !hasImage(modelImage)) {
      warn('Model is set to "my own photo" but none is attached — a model will be created instead.');
    }
    if (payloadBytes > limits.maxRequestMb * 1024 * 1024) {
      warn(`The request is ${kb(payloadBytes)} — over the ${limits.maxRequestMb} MB limit (413).`);
    }

    // The service warns about this too; saying it early saves a paid run.
    const front = areaIds.some((a) => ['FRONT', 'NECK', 'PALLU', 'BODY', 'WAISTBAND', 'SKIRT'].includes(a));
    if (areaIds.includes('BACK') && front) {
      warn('A BACK design turns the model around, so front areas in the same request will be hidden.');
    }
    // Measured: a dense fabric on the same part tends to out-shout its design.
    sent.forEach((f, i) => {
      const patterned = /brocade|jaal|jacquard|self design|woven pattern/i.test(`${f.name} ${f.material}`);
      const overlaps = f.appliesTo.length ? f.appliesTo.some((a) => areaIds.includes(a)) : areaIds.length > 0;
      if (patterned && overlaps) {
        warn(`Fabric ${i + 1} sounds patterned and covers a part that also has a design — the fabric may dominate it. A plainer fabric for that part reproduces the design better.`);
      }
    });
    return list;
  }, [clientId, garment, current, designs, fabrics, modelKind, modelImage, pairColor, pairColorHex, pairNote, limits, payloadBytes]);

  const blocked = checks.some((c) => c.level === 'block');

  // ── Run ────────────────────────────────────────────────────────────────────
  async function run() {
    if (running) return;
    const myRun = ++runRef.current;
    const body = payload; // exactly what the preview above showed
    setError(null); setImage(null); setDone(null); setBrief(null);
    setStartInfo(null); setEvents([]); setKeepalives(0); setCancelNote(null);
    setRunning(true);

    const ac = new AbortController();
    abortRef.current = ac;
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    const push = (row) => { if (runRef.current === myRun) setEvents((prev) => [...prev, row]); };

    try {
      const result = await generateGarment(body, (e) => {
        if (runRef.current !== myRun) return;
        push({
          at: at(), type: e.type, stage: e.stage, attempt: e.attempt,
          message: e.message || e.code, code: e.code, raw: e.type === 'image' ? null : e
        });
        if (e.type === 'start') setStartInfo(e);
        if (e.type === 'brief') setBrief(e);
        if (e.type === 'image') setImage(e);
        if (e.type === 'done') setDone(e);
        if (e.type === 'error') {
          setError({ status: 200, inStream: true, code: e.code, message: e.message, retryable: e.retryable, details: e.details });
        }
      }, ac.signal);

      if (runRef.current !== myRun) return;
      setKeepalives(result.keepalives || 0);
      if (result.aborted) push({ at: at(), type: 'aborted', message: 'Stopped from this page.' });
    } catch (err) {
      if (runRef.current !== myRun) return;
      setError(err);
      push({ at: at(), type: 'refused', message: `HTTP ${err.status} ${err.code}` });
    } finally {
      if (runRef.current === myRun) setRunning(false);
    }
  }

  async function stop() {
    const response = await cancelGarment(clean(clientId));
    setCancelNote(response && response.message ? response.message : 'Cancel sent.');
    if (abortRef.current) abortRef.current.abort();
    setRunning(false);
  }

  function resetAll() {
    if (abortRef.current) abortRef.current.abort();
    setDesigns([blankDesign()]); setFabrics([blankFabric()]);
    setModelKind('generated'); setModelImage(null); setModelGender('');
    setPairColor(''); setPairColorHex(''); setPairNote('');
    setEvents([]); setStartInfo(null); setBrief(null); setImage(null);
    setDone(null); setError(null); setCancelNote(null); setRunning(false);
  }

  const usedAreas = designs.map((d) => d.area).filter(Boolean);

  return (
    <div className="ds-wrap">
      <header className="ds-header">
        <h1>Design Studio</h1>
        <p className="ds-sub">
          Send the designs and fabrics a third party picked, get one finished garment worn by a model.
          {options ? ` ${garments.length} garments · up to ${limits.maxDesigns} designs and ${limits.maxFabrics} fabrics · portrait ${options.model.aspectRatio} · returned as base64.` : ' Loading options…'}
          <span className="ds-endpoint">{DESIGNSTUDIO_BASE}</span>
        </p>
      </header>

      {optionsError && (
        <div className="ds-error">
          <strong>Could not load GET /options — HTTP {optionsError.status} {optionsError.code}</strong>
          <div>{optionsError.message}</div>
        </div>
      )}

      {/* ── 1. The product ──────────────────────────────────────────────── */}
      <section className="ds-card">
        <h3>1 · The product</h3>

        <div className="ds-examples">
          <span className="ds-label">Start from:</span>
          {PRESETS.map((p) => (
            <button key={p.label} className="ds-chip" onClick={() => applyPreset(p)} disabled={running}>{p.label}</button>
          ))}
        </div>

        <div className="ds-row">
          <div className="ds-field">
            <label>garment</label>
            <select value={garment} onChange={(e) => pickGarment(e.target.value)} disabled={running || !options}>
              {garments.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.id}</option>)}
            </select>
            {current && <small>Default model: {current.defaultModelGender}. {current.designAreas.length} design areas.</small>}
          </div>
          <div className="ds-field">
            <label>productName <span className="ds-hint">style hint only, never drawn</span></label>
            <input value={productName} onChange={(e) => setProductName(e.target.value)} disabled={running}
              placeholder="Bridal Banarasi Saree" maxLength={120} />
          </div>
          <div className="ds-field">
            <label>clientId <span className="ds-hint">what /cancel stops</span></label>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={running} maxLength={128} />
          </div>
        </div>

        <div className="ds-row">
          <div className="ds-field ds-grow">
            <label>{shape === 'catalogue' ? 'instructions' : 'notes'} <span className="ds-hint">references always win over words</span></label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={600} disabled={running} />
          </div>
        </div>

        <h4>The model</h4>
        <div className="ds-row">
          <div className="ds-field">
            <label>model</label>
            <div className="ds-radios">
              {[['generated', 'Created for me'], ['reference', 'My own photo']].map(([value, text]) => (
                <label key={value} className={'ds-radio' + (modelKind === value ? ' on' : '')}>
                  <input type="radio" name="ds-model" checked={modelKind === value} disabled={running}
                    onChange={() => setModelKind(value)} />
                  {text}
                </label>
              ))}
            </div>
          </div>
          <div className="ds-field">
            <label>modelGender <span className="ds-hint">blank = the garment's usual wearer</span></label>
            <select value={modelGender} onChange={(e) => setModelGender(e.target.value)} disabled={running}>
              <option value="">(default{current ? `: ${current.defaultModelGender}` : ''})</option>
              {((options && options.modelGenders) || ['female', 'male']).map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          {modelKind === 'reference' && (
            <div className="ds-field ds-grow">
              <label>modelImage</label>
              <ImagePicker slot={modelImage} onChange={setModelImage} disabled={running} compact />
            </div>
          )}
        </div>

        <h4>Worn with it <span className="ds-hint">pairWith — never the product, never designed</span></h4>
        {current && current.pairedWith === undefined ? (
          <p className="ds-note">
            This service does not report <code>pairedWith</code> yet — it is running older code. Restart it to see
            what a {current.name.toLowerCase()} is worn with. <code>pairWith</code> is still sent as typed.
          </p>
        ) : current && current.pairedWith ? (
          <p className="ds-note">
            The <strong>{current.name.toLowerCase()}</strong> is the product. A real photo also needs a supporting{' '}
            <strong>{current.pairedWith.pieces}</strong>, kept plain — none of your designs are used there.
            Default colour when left blank: {current.pairedWith.defaultColour}.
            {current.framing && current.framing !== 'full' && (
              <> Photographed <strong>{current.framing}</strong>, so the {current.name.toLowerCase()} fills the frame.</>
            )}
          </p>
        ) : (
          <p className="ds-note">
            {current ? `A ${current.name.toLowerCase()} is the whole outfit, so nothing else is worn with it.` : 'Loading…'}
          </p>
        )}
        <div className="ds-row">
          <div className="ds-field">
            <label>pairWith.color</label>
            <input value={pairColor} onChange={(e) => setPairColor(e.target.value)} maxLength={60} disabled={running}
              placeholder={current && current.pairedWith && current.pairedWith.pieces === 'blouse' ? 'antique gold' : 'cream'} />
          </div>
          <div className="ds-field ds-narrow">
            <label>pairWith.colorHex</label>
            <div className="ds-hexrow">
              <input type="color" value={hexish(pairColorHex) ? asHex(pairColorHex) : '#C9A227'}
                onChange={(e) => setPairColorHex(e.target.value)} disabled={running} />
              <input value={pairColorHex} onChange={(e) => setPairColorHex(e.target.value)}
                placeholder="#C9A227" disabled={running} />
            </div>
          </div>
          <div className="ds-field ds-grow">
            <label>pairWith.note</label>
            <input value={pairNote} onChange={(e) => setPairNote(e.target.value)} maxLength={300} disabled={running}
              placeholder={current && current.pairedWith && current.pairedWith.pieces === 'blouse' ? 'short puff sleeves' : 'matte crepe'} />
          </div>
        </div>
      </section>

      {/* ── 2. Designs ──────────────────────────────────────────────────── */}
      <section className="ds-card">
        <h3>2 · Designs <span className="ds-hint">one per area, {designs.length}/{limits.maxDesigns}</span></h3>
        <p className="ds-note">
          Crop each picture to the design itself — a close-up of the pallu, not a whole person wearing a saree.
          The reference supplies motifs only; the part's colour comes from its fabric.
        </p>

        {designs.map((d, i) => (
          <div className="ds-item" key={d.id}>
            <div className="ds-item-head">
              <strong>designs[{i}]</strong>
              <button className="ds-remove" disabled={running || designs.length === 1}
                onClick={() => setDesigns((prev) => prev.filter((x) => x.id !== d.id))}>Remove</button>
            </div>

            <div className="ds-row">
              <div className="ds-field">
                <label>area</label>
                <select value={d.area} onChange={(e) => updateDesign(d.id, { area: e.target.value })} disabled={running || !options}>
                  <option value="">— pick an area —</option>
                  {areas.map((a) => (
                    <option key={a.id} value={a.id} disabled={usedAreas.includes(a.id) && d.area !== a.id}>
                      {a.name} · {a.id}{usedAreas.includes(a.id) && d.area !== a.id ? ' (used)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ds-field ds-grow">
                <label>note <span className="ds-hint">naming a motif helps it survive</span></label>
                <input value={d.note} onChange={(e) => updateDesign(d.id, { note: e.target.value })}
                  placeholder="gold zari peacock motifs, widely spaced" maxLength={300} disabled={running} />
              </div>
            </div>

            <ImagePicker slot={d.image} onChange={(slot) => updateDesign(d.id, { image: slot })} disabled={running} />

            <button className="ds-toggle" onClick={() => updateDesign(d.id, { advanced: !d.advanced })}>
              {d.advanced ? '▾' : '▸'} per-part colour controls
            </button>
            {d.advanced && (
              <div className="ds-row ds-advanced">
                <div className="ds-field">
                  <label>groundColor <span className="ds-hint">override</span></label>
                  <input value={d.groundColor} onChange={(e) => updateDesign(d.id, { groundColor: e.target.value })}
                    placeholder="ivory" maxLength={60} disabled={running} />
                </div>
                <div className="ds-field ds-narrow">
                  <label>groundColorHex</label>
                  <div className="ds-hexrow">
                    <input type="color" value={hexish(d.groundColorHex) ? asHex(d.groundColorHex) : '#F2E8DC'}
                      onChange={(e) => updateDesign(d.id, { groundColorHex: e.target.value })} disabled={running} />
                    <input value={d.groundColorHex} onChange={(e) => updateDesign(d.id, { groundColorHex: e.target.value })}
                      placeholder="#F2E8DC" disabled={running} />
                  </div>
                  <small>Blank is normal: the covering fabric's colour is used automatically.</small>
                </div>
                <div className="ds-field">
                  <label>coverage</label>
                  <select value={d.coverage} onChange={(e) => updateDesign(d.id, { coverage: e.target.value })} disabled={running}>
                    <option value="full">full — cover the whole part</option>
                    <option value="reference">reference — copy its layout, gaps included</option>
                  </select>
                </div>
                <div className="ds-field">
                  <label>keepMotifColors</label>
                  <label className="ds-check">
                    <input type="checkbox" checked={d.keepMotifColors} disabled={running}
                      onChange={(e) => updateDesign(d.id, { keepMotifColors: e.target.checked })} />
                    keep the reference's own motif colours
                  </label>
                </div>
              </div>
            )}
          </div>
        ))}

        <button className="ds-add" disabled={running || designs.length >= limits.maxDesigns}
          onClick={() => setDesigns((prev) => [...prev, blankDesign()])}>+ Add a design</button>
      </section>

      {/* ── 3. Fabrics ──────────────────────────────────────────────────── */}
      <section className="ds-card">
        <h3>3 · Fabrics <span className="ds-hint">{fabrics.length}/{limits.maxFabrics}</span></h3>
        <p className="ds-note">
          A stated colour or hex wins over the photo's shade, because a swatch can be shot in warm or cool
          light. Leave <code>appliesTo</code> empty for the main fabric — it covers every part without its own.
        </p>

        {fabrics.map((f, i) => (
          <div className="ds-item" key={f.id}>
            <div className="ds-item-head">
              <strong>fabrics[{i}]</strong>
              <span className="ds-tag">{f.appliesTo.length ? f.appliesTo.join(' + ') : 'MAIN — everything else'}</span>
              <button className="ds-remove" disabled={running}
                onClick={() => setFabrics((prev) => prev.filter((x) => x.id !== f.id))}>Remove</button>
            </div>

            <div className="ds-row">
              <div className="ds-field">
                <label>name</label>
                <input value={f.name} onChange={(e) => updateFabric(f.id, { name: e.target.value })}
                  placeholder="Plain wine silk" maxLength={80} disabled={running} />
              </div>
              <div className="ds-field ds-grow">
                <label>material</label>
                <input value={f.material} onChange={(e) => updateFabric(f.id, { material: e.target.value })}
                  placeholder="Plain mulberry silk with a soft sheen" maxLength={120} disabled={running} />
              </div>
              <div className="ds-field ds-narrow">
                <label>itemCode</label>
                <input value={f.itemCode} onChange={(e) => updateFabric(f.id, { itemCode: e.target.value })}
                  placeholder="FAB-0003" maxLength={40} disabled={running} />
              </div>
            </div>

            <div className="ds-row">
              <div className="ds-field">
                <label>color <span className="ds-hint">in words</span></label>
                <input value={f.color} onChange={(e) => updateFabric(f.id, { color: e.target.value })}
                  placeholder="wine" maxLength={60} disabled={running} />
              </div>
              <div className="ds-field ds-narrow">
                <label>colorHex</label>
                <div className="ds-hexrow">
                  <input type="color" value={hexish(f.colorHex) ? asHex(f.colorHex) : '#722F37'}
                    onChange={(e) => updateFabric(f.id, { colorHex: e.target.value })} disabled={running} />
                  <input value={f.colorHex} onChange={(e) => updateFabric(f.id, { colorHex: e.target.value })}
                    placeholder="#722F37" disabled={running} />
                </div>
              </div>
              <div className="ds-field ds-narrow">
                <label>quantityMeters <span className="ds-hint">ignored</span></label>
                <input value={f.quantityMeters} onChange={(e) => updateFabric(f.id, { quantityMeters: e.target.value })}
                  placeholder="5.5" disabled={running || shape !== 'catalogue'} />
                {shape !== 'catalogue' && <small>Sent only in the catalogue shape.</small>}
              </div>
              <div className="ds-field ds-grow">
                <label>note</label>
                <input value={f.note} onChange={(e) => updateFabric(f.id, { note: e.target.value })}
                  placeholder="keep the weave visible" maxLength={300} disabled={running} />
              </div>
            </div>

            <div className="ds-field">
              <label>appliesTo <span className="ds-hint">empty = the main fabric</span></label>
              <div className="ds-areas">
                {areas.map((a) => (
                  <button key={a.id} disabled={running}
                    className={'ds-area' + (f.appliesTo.includes(a.id) ? ' on' : '') + (usedAreas.includes(a.id) ? ' has-design' : '')}
                    onClick={() => toggleApplies(f.id, a.id)}>{a.id}</button>
                ))}
              </div>
            </div>

            <ImagePicker slot={f.image} onChange={(slot) => updateFabric(f.id, { image: slot })} disabled={running} />
          </div>
        ))}

        <button className="ds-add" disabled={running || fabrics.length >= limits.maxFabrics}
          onClick={() => setFabrics((prev) => [...prev, blankFabric()])}>+ Add a fabric</button>
      </section>

      {/* ── 4. Send ─────────────────────────────────────────────────────── */}
      <section className="ds-card">
        <h3>4 · The exact payload</h3>

        <div className="ds-modes">
          {[['canonical', 'Short form (garment / designs / image)'],
            ['catalogue', 'Catalogue form (productType / parts / details)']].map(([value, text]) => (
            <button key={value} className={'ds-mode' + (shape === value ? ' active' : '')}
              onClick={() => setShape(value)} disabled={running}>{text}</button>
          ))}
        </div>
        <p className="ds-note">
          Both spellings are accepted and produce the same result. The catalogue form also uses the British
          spellings (<code>colour</code>, <code>groundColour</code>) and sends <code>quantityMeters</code>,
          which the service accepts and ignores.
        </p>

        {checks.length > 0 && (
          <ul className="ds-checks">
            {checks.map((c, i) => (
              <li key={i} className={c.level === 'block' ? 'ds-block' : 'ds-warn'}>
                <span>{c.level === 'block' ? 'must fix' : 'heads up'}</span>{c.text}
              </li>
            ))}
          </ul>
        )}

        <details className="ds-payload" open>
          <summary>
            POST /generate — {kb(payloadBytes)} of JSON
            {payloadBytes > limits.maxRequestMb * 1024 * 1024 ? ' (over the limit)' : ''}
          </summary>
          <pre>{preview}</pre>
          <button className="ds-secondary" onClick={() => navigator.clipboard.writeText(preview)}>
            Copy this preview
          </button>
          <small className="ds-hint"> The real request carries the full base64 in place of the shortened strings.</small>
        </details>

        <div className="ds-actions">
          <button className="ds-run" onClick={run} disabled={running || blocked}>
            {running ? 'Generating…' : 'Generate the garment'}
          </button>
          <button className="ds-secondary" onClick={stop} disabled={!running}>Cancel</button>
          <button className="ds-secondary" onClick={resetAll} disabled={running}>Clear everything</button>
          {cancelNote && <span className="ds-hint">{cancelNote}</span>}
        </div>
        <p className="ds-note">Measured: 25–60 seconds, plus 2–8s for reading the references. A slow attempt is cut off at 100s and tried once more.</p>
      </section>

      {/* ── 5. What came back ───────────────────────────────────────────── */}
      {(events.length > 0 || error) && (
        <section className="ds-card">
          <h3>5 · The stream</h3>

          {error && (
            <div className="ds-error">
              <strong>
                {error.inStream ? 'error event' : `HTTP ${error.status}`} · {error.code}
                {error.retryable ? ' · retryable' : ''}
                {error.retryAfter ? ` · retry after ${error.retryAfter}s` : ''}
              </strong>
              <div>{error.message}</div>
              {Array.isArray(error.details) && error.details.length > 0 && (
                <ul>
                  {error.details.map((d, i) => (
                    <li key={i}><code>{d.field || '(request)'}</code> {d.code}{d.message ? ` — ${d.message}` : ''}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {startInfo && (
            <div className="ds-start">
              <div className="ds-kv"><span className="ds-label">jobId</span><code>{startInfo.jobId}</code></div>
              <div className="ds-kv"><span className="ds-label">garment</span>{startInfo.garment}</div>
              <div className="ds-kv"><span className="ds-label">model</span>{startInfo.model} · {startInfo.pose} pose{startInfo.framing ? ` · ${startInfo.framing}` : ''}</div>
              <div className="ds-kv"><span className="ds-label">aspect</span>{startInfo.aspectRatio}</div>
              <div className="ds-kv ds-kv-wide">
                <span className="ds-label">designs</span>
                {startInfo.designs.map((d) => `${d.areaName} (${d.area})`).join(' · ')}
              </div>
              {startInfo.fabrics.length > 0 && (
                <div className="ds-kv ds-kv-wide">
                  <span className="ds-label">fabrics echoed back</span>
                  {startInfo.fabrics.map((f) =>
                    `${f.name || '(unnamed)'}${f.itemCode ? ` [${f.itemCode}]` : ''}${f.color ? ` ${f.color}` : ''} → ${Array.isArray(f.appliesTo) ? f.appliesTo.join('+') : f.appliesTo}`
                  ).join(' · ')}
                </div>
              )}
              <div className="ds-kv ds-kv-wide">
                <span className="ds-label">worn with it</span>
                {startInfo.pairedWith
                  ? `${startInfo.pairedWith.pieces} — ${startInfo.pairedWith.colour} (from ${startInfo.pairedWith.from})${startInfo.pairedWith.note ? ` · ${startInfo.pairedWith.note}` : ''}`
                  : 'nothing — the product is the whole outfit'}
              </div>
              {startInfo.warnings && startInfo.warnings.length > 0 && (
                <ul className="ds-warnings">
                  {startInfo.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>
          )}

          {brief && (
            <div className="ds-brief">
              <h4>What the service understood from each picture</h4>
              <div className="ds-brief-grid">
                {brief.references.map((r) => (
                  <div className="ds-brief-card" key={r.ref}>
                    <strong>{r.ref}</strong>
                    {r.motifs && <p><span className="ds-label">motifs</span> {r.motifs}</p>}
                    {r.layout && <p><span className="ds-label">layout</span> {r.layout}</p>}
                    {r.colours && <p><span className="ds-label">colours</span> {r.colours}</p>}
                    {r.technique && <p><span className="ds-label">technique</span> {r.technique}</p>}
                    {r.notes && <p><span className="ds-label">notes</span> {r.notes}</p>}
                  </div>
                ))}
              </div>
              {brief.warnings && brief.warnings.length > 0 && (
                <ul className="ds-warnings">{brief.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              )}
            </div>
          )}

          <ol className="ds-timeline">
            {events.map((e, i) => (
              <li key={i}>
                <code>{String(e.at).padStart(6)}ms</code>
                <span className={'ds-evt ds-evt-' + e.type}>{e.type}{e.stage ? ` · ${e.stage}` : ''}{e.attempt ? ` · attempt ${e.attempt}` : ''}</span>
                <span>{e.message}</span>
              </li>
            ))}
            {running && <li className="ds-pending"><code>…</code><span className="ds-evt">working</span><span>keep-alive pings keep the connection open.</span></li>}
          </ol>

          {done && (
            <div className="ds-timings">
              <span>attempts <strong>{done.attempts}</strong></span>
              <span>prepare <strong>{done.timings.prepareMs}ms</strong></span>
              <span>read references <strong>{done.timings.describeMs}ms</strong></span>
              <span>generate <strong>{(done.timings.generateMs / 1000).toFixed(1)}s</strong></span>
              <span>total <strong>{(done.timings.totalMs / 1000).toFixed(1)}s</strong></span>
              {keepalives > 0 && <span>keep-alives <strong>{keepalives}</strong></span>}
            </div>
          )}

          {events.length > 0 && (
            <details className="ds-payload">
              <summary>Raw events (image bytes left out)</summary>
              <pre>{JSON.stringify(events.map((e) => e.raw).filter(Boolean), null, 2)}</pre>
            </details>
          )}
        </section>
      )}

      {image && (
        <section className="ds-card ds-result">
          <h3>The product</h3>
          <div className="ds-result-body">
            <img src={image.image} alt="the generated garment" />
            <div className="ds-result-meta">
              <div className="ds-kv"><span className="ds-label">size</span>{image.width} × {image.height}</div>
              <div className="ds-kv"><span className="ds-label">bytes</span>{kb(image.bytes)}</div>
              <div className="ds-kv"><span className="ds-label">type</span>{image.mimeType}</div>
              <div className="ds-kv"><span className="ds-label">delivered as</span>data:image/jpeg;base64</div>
              <div className="ds-result-actions">
                {blobUrl && <a className="ds-secondary" href={blobUrl} download={`${(productName || garment).replace(/\W+/g, '-').toLowerCase()}.jpg`}>Download</a>}
                {blobUrl && <a className="ds-secondary" href={blobUrl} target="_blank" rel="noreferrer">Open full size</a>}
                <button className="ds-secondary" onClick={() => navigator.clipboard.writeText(image.image)}>Copy base64</button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

// =============================================================================
// ImagePicker — one image, as a file or an https Cloudinary link.
// =============================================================================
//
// Upload, drag-and-drop or paste give a data URI, which the service accepts
// directly. The link mode covers the other half of the contract, and the demo
// links below let the whole path be tested with no files at all.
function ImagePicker({ slot, onChange, disabled, compact }) {
  const [mode, setMode] = useState(slot && slot.mode === 'url' ? 'url' : 'file');
  const [readError, setReadError] = useState(null);
  const inputRef = useRef(null);

  async function take(file) {
    if (!file) return;
    setReadError(null);
    try {
      onChange(await readImageFile(file));
      setMode('file');
    } catch (err) {
      setReadError(err.message);
    }
  }

  const onDrop = (e) => {
    e.preventDefault();
    if (disabled) return;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) take(file);
  };

  const onPaste = (e) => {
    if (disabled) return;
    const item = [...(e.clipboardData.items || [])].find((x) => x.type.startsWith('image/'));
    if (item) { e.preventDefault(); take(item.getAsFile()); }
  };

  const url = slot && slot.mode === 'url' ? clean(slot.url) : '';
  const badHost = url.length > 0 && !CLOUDINARY.test(url);
  const src = slot ? (slot.mode === 'url' ? url : slot.dataUrl) : '';

  return (
    <div className={'ds-picker' + (compact ? ' compact' : '')}>
      <div className="ds-picker-modes">
        <button className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')} disabled={disabled}>Upload</button>
        <button className={mode === 'url' ? 'on' : ''} onClick={() => setMode('url')} disabled={disabled}>Cloudinary link</button>
        {slot && <button className="ds-clear" onClick={() => onChange(null)} disabled={disabled}>Clear</button>}
      </div>

      {mode === 'file' ? (
        <div className="ds-drop" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onPaste={onPaste} tabIndex={0}
          onClick={() => inputRef.current && inputRef.current.click()}>
          <input ref={inputRef} type="file" accept="image/*,.heic,.heif" hidden disabled={disabled}
            onChange={(e) => take(e.target.files[0])} />
          <span>Click, drop or paste a picture — sent as base64</span>
        </div>
      ) : (
        <div className="ds-urlbox">
          <input value={url} disabled={disabled} placeholder="https://res.cloudinary.com/…"
            onChange={(e) => onChange({ mode: 'url', url: e.target.value, dataUrl: '', fileName: '', bytes: 0, width: 0, height: 0 })} />
          <div className="ds-demos">
            {DEMO_LINKS.map((d) => (
              <button key={d.label} className="ds-chip" disabled={disabled}
                onClick={() => onChange({ mode: 'url', url: d.url, dataUrl: '', fileName: '', bytes: 0, width: 0, height: 0 })}>
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {readError && <small className="ds-bad">{readError}</small>}

      {slot && (src || url) && (
        <div className="ds-thumb">
          <img src={src} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
          <div className="ds-thumb-meta">
            {slot.mode === 'file' ? (
              <>
                <div>{slot.fileName}</div>
                <div>{slot.width && slot.height ? `${slot.width} × ${slot.height}` : 'the browser cannot preview this format — the service still reads it'} · {kb(slot.bytes)}</div>
                <div className="ds-hint">base64 ≈ {kb(Math.ceil(slot.bytes * 1.37))} in the request</div>
              </>
            ) : (
              <>
                <div className="ds-break">{url}</div>
                <div className={badHost ? 'ds-bad' : 'ds-hint'}>
                  {badHost ? 'Not on res.cloudinary.com — this will be refused (that is a valid test).' : 'Allowed host.'}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
