import { useState, useEffect } from 'react';
import { generateCatalog, cancelGeneration } from './apiMen';
import './men-index.css';

// ============================================================
// CATEGORIES
// ============================================================

const TOP_WEAR = [
  { value: 'T-SHIRTS', label: 'T-Shirts' },
  { value: 'POLO_T-SHIRTS', label: 'Polo T-Shirts' },
  { value: 'SHIRTS', label: 'Shirts' },
  { value: 'KURTAS', label: 'Kurtas' },
  { value: 'HOODIES', label: 'Hoodies' },
  { value: 'SWEATSHIRTS', label: 'Sweatshirts' },
  { value: 'QUARTER_ZIP', label: 'Quarter Zip' },
  { value: 'REGULAR_FIT_TEE', label: 'Regular Fit Tee' },
  { value: 'SLIM_FIT_TEE', label: 'Slim Fit Tee' },
  { value: 'MUSCLE_TEE', label: 'Muscle Tee' }
];

const OUTERWEAR = [
  { value: 'JACKETS', label: 'Jackets' },
  { value: 'BLAZERS', label: 'Blazers' }
];

const BOTTOM_WEAR = [
  { value: 'STRAIGHT_FIT_PANTS', label: 'Straight Fit Pants' },
  { value: 'TAPERED_FIT_PANTS', label: 'Tapered Fit Pants' },
  { value: 'PANTS', label: 'Pants' },
  { value: 'TROUSERS', label: 'Trousers' },
  { value: 'JEANS', label: 'Jeans' },
  { value: 'TRACKS', label: 'Tracks' },
  { value: 'SHORTS', label: 'Shorts' }
];

const STANDARD_SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const WAIST_SIZES = ['28', '30', '32', '34', '36', '38', '40'];

const getCategoryGroup = (cat) => {
  if (TOP_WEAR.find(c => c.value === cat)) return 'TOP_WEAR';
  if (OUTERWEAR.find(c => c.value === cat)) return 'OUTERWEAR';
  if (BOTTOM_WEAR.find(c => c.value === cat)) return 'BOTTOM_WEAR';
  return 'TOP_WEAR';
};

const getCategoryType = (cat) => {
  return getCategoryGroup(cat) === 'BOTTOM_WEAR' ? 'waist' : 'standard';
};

// ============================================================
// APP
// ============================================================

function App() {
  const [category, setCategory] = useState('T-SHIRTS');
  const [garment, setGarment] = useState(null);
  const [tops, setTops] = useState([]);
  const [userPhoto, setUserPhoto] = useState(null);

  // Sizing and caching
  const [selectedSize, setSelectedSize] = useState(null);
  const [selectedTopIndex, setSelectedTopIndex] = useState(0);
  const [sizeResults, setSizeResults] = useState({});
  const [sizeStatus, setSizeStatus] = useState({});

  // Generation state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);
  const [abortController, setAbortController] = useState(null);

  // Cancel on unload
  useEffect(() => {
    const handleUnload = () => cancelGeneration('men-frontend');
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  // Handlers
  const handleCategoryChange = (event) => {
    setCategory(event.target.value);
    setGarment(null);
    setTops([]);
    setUserPhoto(null);
    resetState();
  };

  const handleGarmentChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setGarment({ preview: URL.createObjectURL(file), base64: reader.result });
      resetState();
    };
    reader.readAsDataURL(file);
  };

  const handleTopsChange = (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    
    // Process each file
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setTops(prev => [...prev, { preview: URL.createObjectURL(file), base64: reader.result }]);
      };
      reader.readAsDataURL(file);
    });
    resetState();
  };

  const removeTop = (index) => {
    setTops(prev => prev.filter((_, i) => i !== index));
    resetState();
  };

  const handleUserPhotoChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setUserPhoto({ preview: URL.createObjectURL(file), base64: reader.result });
      resetState();
    };
    reader.readAsDataURL(file);
  };

  const clearGarment = () => {
    setGarment(null);
    resetState();
  };

  const clearUserPhoto = () => {
    setUserPhoto(null);
    resetState();
  };

  const resetState = () => {
    setSelectedSize(null);
    setSizeResults({});
    setSizeStatus({});
    setError(null);
    setStatusMsg(null);
  };

  const handleSizeChange = (size) => {
    setSelectedSize(size);
  };

  const handleGenerate = async () => {
    if (!garment) {
      setError(getCategoryGroup(category) === 'BOTTOM_WEAR' ? 'Please upload the bottom garment first.' : 'Please upload the garment picture first.');
      return;
    }
    
    const isMixAndMatch = getCategoryGroup(category) === 'BOTTOM_WEAR';
    if (isMixAndMatch && tops.length === 0) {
      setError('Please upload at least one top garment for mix-and-match.');
      return;
    }

    setLoading(true);
    setError(null);
    setStatusMsg('Starting batch generation...');
    
    // Reset statuses to PENDING
    const initialStatus = {};
    const currentSizeOptions = getCategoryType(category) === 'waist' ? WAIST_SIZES : STANDARD_SIZES;
    currentSizeOptions.forEach(s => initialStatus[s] = 'PENDING');
    setSizeStatus(initialStatus);

    const controller = new AbortController();
    setAbortController(controller);

    try {
      await generateCatalog(
        {
          fullDress: garment.base64,
          tops: isMixAndMatch ? tops.map(t => t.base64) : null,
          category,
          categoryGroup: getCategoryGroup(category),
          sizes: currentSizeOptions,
          sizeType: getCategoryType(category),
          userPhoto: userPhoto ? userPhoto.base64 : null
        },
        (event) => {
          if (event.type === 'STATUS') {
            setStatusMsg(event.message);
          } else if (event.type === 'SIZE_STATUS') {
            setSizeStatus(prev => ({ ...prev, [event.size]: event.status }));
          } else if (event.type === 'SIZE_READY') {
            setSizeStatus(prev => ({ ...prev, [event.size]: 'READY' }));
            setSizeResults(prev => {
              if (isMixAndMatch && event.topIndex !== undefined) {
                const currentSizeData = prev[event.size] || {};
                return {
                  ...prev,
                  [event.size]: { ...currentSizeData, [event.topIndex]: event.result || event.image }
                };
              }
              return { ...prev, [event.size]: event.result || event.image };
            });
            setSelectedSize(currentSize => {
              if (!currentSize) return event.size;
              return currentSize;
            });
          } else if (event.type === 'VIEW_READY' && event.view === 'front') {
             // Fallback for older server events if necessary
             setSizeResults(prev => ({ ...prev, [event.size]: event.image }));
             setSizeStatus(prev => ({ ...prev, [event.size]: 'READY' }));
          } else if (event.type === 'COMPLETE') {
            if (event.results) {
               setSizeResults(prev => ({ ...prev, ...event.results }));
               const newStatus = {};
               Object.keys(event.results).forEach(s => newStatus[s] = 'READY');
               setSizeStatus(prev => ({ ...prev, ...newStatus }));
            }
            setLoading(false);
            setStatusMsg(null);
          }
        },
        controller.signal
      );
    } catch (err) {
      if (err.name === 'AbortError') {
        setError('Generation cancelled.');
      } else {
        console.error(err);
        setError(err.message || 'Generation failed.');
      }
    } finally {
      setLoading(false);
      setAbortController(null);
      setStatusMsg(null);
    }
  };

  const handleCancel = () => {
    if (abortController) abortController.abort();
    cancelGeneration('men-frontend');
    setLoading(false);
    setError('Generation cancelled by user.');
    setStatusMsg(null);
  };

  const sizeType = getCategoryType(category);
  const sizeOptions = sizeType === 'waist' ? WAIST_SIZES : STANDARD_SIZES;
  const sizeLabel = sizeType === 'waist' ? 'Waist Size' : 'Size';
  const isMixAndMatch = getCategoryGroup(category) === 'BOTTOM_WEAR';
  
  let displayedResult = null;
  if (selectedSize && sizeResults[selectedSize]) {
    if (isMixAndMatch) {
      displayedResult = sizeResults[selectedSize][selectedTopIndex];
    } else {
      displayedResult = sizeResults[selectedSize];
    }
  }

  return (
    <div className="ecom-container">
      <header className="ecom-header">
        <h1>Men's Draping AI</h1>
        <p>Virtual Try-On Experience</p>
      </header>

      <main className="ecom-main">
        {/* LEFT COLUMN: LARGE IMAGE */}
        <div className="ecom-left">
          {displayedResult ? (
            <div className="ecom-image-wrapper">
              <img src={displayedResult} alt="Generated Fit" className="ecom-large-image" />
              {(loading && selectedSize && sizeStatus[selectedSize] !== 'READY') && (
                <div className="ecom-image-overlay">
                  <span className="spinner"></span>
                  <p>{statusMsg || 'Generating...'}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="ecom-placeholder">
              {loading || (selectedSize && sizeStatus[selectedSize] !== 'READY') ? (
                <div className="ecom-loading-box">
                  <span className="spinner"></span>
                  <p>{statusMsg || (selectedSize ? `Generating size ${selectedSize}...` : 'Generating...')}</p>
                </div>
              ) : (
                <p>Select a size to view the try-on result.</p>
              )}
            </div>
          )}
          
          {/* MIX AND MATCH RESULT CONTROLS */}
          {(isMixAndMatch && sizeResults[selectedSize] && Object.keys(sizeResults[selectedSize]).length > 0) && (
            <div className="ecom-mixmatch-controls" style={{marginTop: '20px', display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center'}}>
              {Object.keys(sizeResults[selectedSize]).map((topIdxStr) => {
                const idx = parseInt(topIdxStr);
                return (
                  <button 
                    key={idx}
                    className={`ecom-size-btn ${selectedTopIndex === idx ? 'active' : ''}`}
                    onClick={() => setSelectedTopIndex(idx)}
                  >
                    Top {idx + 1}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: CONTROLS */}
        <div className="ecom-right">
          <h2>Product Configuration</h2>
          
          {error && <div className="ecom-error">{error}</div>}

          <div className="ecom-control-group">
            <label>Category</label>
            <select className="ecom-select" value={category} onChange={handleCategoryChange} disabled={loading}>
              <optgroup label="Top Wear">
                {TOP_WEAR.map(item => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </optgroup>
              <optgroup label="Outerwear">
                {OUTERWEAR.map(item => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </optgroup>
              <optgroup label="Bottom Wear">
                {BOTTOM_WEAR.map(item => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </optgroup>
            </select>
          </div>

          <div className="ecom-control-group">
            <label>{isMixAndMatch ? '1. Upload Bottom Garment (Constant)' : '1. Upload Garment'}</label>
            <div className="ecom-upload-box">
              {!garment ? (
                <input type="file" accept="image/*" onChange={handleGarmentChange} disabled={loading} />
              ) : (
                <div className="ecom-preview-row">
                  <img src={garment.preview} alt="Garment" className="ecom-thumb" />
                  <button onClick={clearGarment} disabled={loading} className="ecom-btn-clear">Remove</button>
                </div>
              )}
            </div>
          </div>

          {isMixAndMatch && (
            <div className="ecom-control-group">
              <label>2. Upload Tops (Mix & Match) <span className="optional">(Variable)</span></label>
              <div className="ecom-upload-box">
                <input type="file" accept="image/*" multiple onChange={handleTopsChange} disabled={loading} />
                
                {tops.length > 0 && (
                  <div className="ecom-tops-grid" style={{display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '10px'}}>
                    {tops.map((top, index) => (
                      <div key={index} className="ecom-preview-row" style={{flexDirection: 'column', padding: '5px', border: '1px solid #ccc', borderRadius: '4px'}}>
                        <img src={top.preview} alt={`Top ${index + 1}`} className="ecom-thumb" style={{width: '60px', height: '60px', objectFit: 'contain'}} />
                        <button onClick={() => removeTop(index)} disabled={loading} className="ecom-btn-clear" style={{padding: '2px 5px', fontSize: '10px', marginTop: '5px'}}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {tops.length > 0 && <p className="ecom-help-text">Selected Tops: {tops.length}</p>}
            </div>
          )}

          <div className="ecom-control-group">
            <label>{isMixAndMatch ? '3.' : '2.'} Upload Your Photo <span className="optional">(Optional)</span></label>
            <div className="ecom-upload-box">
              {!userPhoto ? (
                <input type="file" accept="image/*" onChange={handleUserPhotoChange} disabled={loading} />
              ) : (
                <div className="ecom-preview-row">
                  <img src={userPhoto.preview} alt="User" className="ecom-thumb" />
                  <button onClick={clearUserPhoto} disabled={loading} className="ecom-btn-clear">Remove</button>
                </div>
              )}
            </div>
            <p className="ecom-help-text">If no photo is uploaded, an AI model will be used.</p>
          </div>

          <div className="ecom-control-group">
            <label>{sizeLabel}:</label>
            <div className="ecom-size-selector">
              {sizeOptions.map(size => {
                const status = sizeStatus[size];
                return (
                  <button
                    key={size}
                    className={`ecom-size-btn ${selectedSize === size ? 'active' : ''}`}
                    onClick={() => handleSizeChange(size)}
                    title={`Select size ${size}`}
                  >
                    {size}
                  </button>
                );
              })}
            </div>
          </div>
          
          <button className="ecom-btn-generate" onClick={handleGenerate} disabled={loading}>
            {loading ? 'GENERATING ALL SIZES...' : 'GENERATE'}
          </button>

          {loading && (
            <button className="ecom-btn-cancel" onClick={handleCancel} style={{marginTop: '10px'}}>
              🛑 Stop Generation
            </button>
          )}

        </div>
      </main>
    </div>
  );
}

export default App;