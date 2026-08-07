import { useState, useEffect } from 'react';
import { generateCatalog } from './api';
import './index.css';

function App() {
  const [category, setCategory] = useState('SAREE');
  const [inputs, setInputs] = useState({
    fullDress: null,
    topFront: null,
    bottom: null
  });

  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);

  const handleCategoryChange = (e) => {
    setCategory(e.target.value);
    // Clear inputs when category changes to prevent mismatches
    setInputs({ fullDress: null, topFront: null, bottom: null });
    setError(null);
    setResults(null);
    setStatusMsg(null);
  };

  const handleFileChange = (e, fieldName) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setInputs(prev => ({
          ...prev,
          [fieldName]: {
            preview: URL.createObjectURL(selectedFile),
            base64: reader.result
          }
        }));
      };
      reader.readAsDataURL(selectedFile);
    }
  };

  useEffect(() => {
    const handleGlobalPaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            const reader = new FileReader();
            reader.onloadend = () => {
              // Find the first empty slot based on category
              let targetField = null;
              if (category === 'SAREE') {
                if (!inputs.fullDress) targetField = 'fullDress';
                else if (!inputs.topFront) targetField = 'topFront';
              } else if (category === 'LEHANGA' || category === 'SHARARA') {
                if (!inputs.fullDress) targetField = 'fullDress';
                else if (!inputs.topFront) targetField = 'topFront';
                else if (!inputs.bottom) targetField = 'bottom';
              } else if (category === 'ANARKALI') {
                if (!inputs.fullDress) targetField = 'fullDress';
                else if (!inputs.topFront) targetField = 'topFront';
                else if (!inputs.bottom) targetField = 'bottom';
              } else if (category === 'KURTHI') {
                if (!inputs.topFront) targetField = 'topFront';
                else if (!inputs.fullDress) targetField = 'fullDress';
                else if (!inputs.bottom) targetField = 'bottom';
              }

              if (targetField) {
                setInputs(prev => ({
                  ...prev,
                  [targetField]: {
                    preview: URL.createObjectURL(file),
                    base64: reader.result
                  }
                }));
              }
            };
            reader.readAsDataURL(file);
            break; // Only process the first image pasted
          }
        }
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [category, inputs]);

  const clearInput = (fieldName) => {
    setInputs(prev => ({ ...prev, [fieldName]: null }));
  };

  const validateInputs = () => {
    switch (category) {
      case 'SAREE':
        if (!inputs.fullDress) return "Please upload the primary Saree flat-lay (Full Dress).";
        break;
      case 'LEHANGA':
      case 'SHARARA':
        if (!inputs.topFront || !inputs.bottom) return "Please upload both the Top and Bottom garments.";
        break;
      case 'ANARKALI':
        if (!inputs.fullDress) return "Please upload the primary Anarkali suit flat-lay (Full Dress).";
        break;
      case 'KURTHI':
        if (!inputs.topFront) return "Please upload the Top (Kurti) flat-lay.";
        break;
      default:
        if (!inputs.fullDress) return "Please upload the primary garment.";
    }
    return null;
  };

  const handleGenerate = async () => {
    const validationError = validateInputs();
    if (validationError) {
      setError(validationError);
      return;
    }
    
    setLoading(true);
    setError(null);
    // Initialize results so the grid appears immediately with skeletons/placeholders
    setResults({ front: null, back: null, right: null, left: null });
    setStatusMsg("Starting streaming connection...");

    try {
      await generateCatalog({
        category: category,
        fullDress: inputs.fullDress?.base64 || null,
        topFront: inputs.topFront?.base64 || null,
        bottom: inputs.bottom?.base64 || null
      }, (event) => {
        // This callback is fired multiple times over the SSE stream!
        if (event.type === 'STATUS') {
          setStatusMsg(event.message);
        } else if (event.type === 'VIEW_READY') {
          setResults(prev => ({ ...prev, [event.view]: event.image }));
        } else if (event.type === 'COMPLETE') {
          setLoading(false);
          setStatusMsg(null);
        }
      }, "model1");

    } catch (err) {
      setError(err.message);
      setLoading(false);
      setStatusMsg(null);
    }
  };

  const renderUploadSlot = (title, fieldName) => {
    const data = inputs[fieldName];
    
    return (
      <div className="upload-area">
        {!data ? (
          <>
            <input type="file" accept="image/*" onChange={(e) => handleFileChange(e, fieldName)} />
            <div className="upload-icon">📸</div>
            <h4>{title}</h4>
            <p style={{color: 'var(--text-muted)', marginTop: '0.5rem', fontSize: '0.8rem'}}>Click, drag, or Ctrl+V to paste</p>
          </>
        ) : (
          <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%'}}>
            <img src={data.preview} alt={title} className="preview-image" />
            <button className="upload-clear-btn" onClick={() => clearInput(fieldName)}>Remove {title}</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>Draping AI Studio</h1>
        <p>Zero-Retention Microservice Visual Tester</p>
      </header>

      <div className="uploader-card">
        <select className="category-select" value={category} onChange={handleCategoryChange} disabled={loading}>
          <option value="SAREE">Saree</option>
          <option value="LEHANGA">Lehenga</option>
          <option value="ANARKALI">Anarkali</option>
          <option value="SHARARA">Sharara</option>
          <option value="KURTHI">Kurthi</option>
        </select>

        <h3 style={{marginBottom: '2rem', color: 'var(--text-muted)'}}>Upload Garment Components</h3>
        
        <div className="upload-grid">
          {category === 'SAREE' && (
            <>
              {renderUploadSlot("Saree Flat-lay (Required)", "fullDress")}
              {renderUploadSlot("Blouse (Optional)", "topFront")}
            </>
          )}
          
          {(category === 'LEHANGA' || category === 'SHARARA') && (
            <>
              {renderUploadSlot("Full Outfit / Dupatta (Optional)", "fullDress")}
              {renderUploadSlot("Top / Choli / Kurti (Required)", "topFront")}
              {renderUploadSlot("Bottom / Skirt / Pants (Required)", "bottom")}
            </>
          )}

          {category === 'ANARKALI' && (
            <>
              {renderUploadSlot("Anarkali Suit (Required)", "fullDress")}
              {renderUploadSlot("Top / Bodice (Optional)", "topFront")}
              {renderUploadSlot("Bottoms (Optional)", "bottom")}
            </>
          )}

          {category === 'KURTHI' && (
            <>
              {renderUploadSlot("Kurthi Top (Required)", "topFront")}
              {renderUploadSlot("Dupatta / Full (Optional)", "fullDress")}
              {renderUploadSlot("Bottoms (Optional)", "bottom")}
            </>
          )}
        </div>

        <button 
          className="btn-generate" 
          onClick={handleGenerate}
          disabled={loading || !!validateInputs()}
        >
          {loading ? (
            <><div className="spinner"></div> {statusMsg || "Generating..."}</>
          ) : (
            "🚀 Generate Catalog (Model 1)"
          )}
        </button>

        {error && (
          <div className="error-msg">
            <strong>Generation Failed:</strong> {error}
          </div>
        )}
      </div>

      {results && (
        <div style={{marginTop: '4rem'}}>
          <h2 style={{textAlign: 'center', marginBottom: '2rem'}}>Generated Output</h2>
          <div className="results-grid">
            <div className="result-card">
              {results.front ? <img src={results.front} alt="Front View" /> : <div className="skeleton-image">Generating Front...</div>}
              <div className="label">Front View</div>
            </div>
            <div className="result-card">
              {results.back ? <img src={results.back} alt="Back View" /> : <div className="skeleton-image">{results.front ? "Generating Back..." : "Waiting..."}</div>}
              <div className="label">Back View</div>
            </div>
            <div className="result-card">
              {results.right ? <img src={results.right} alt="Side View" /> : <div className="skeleton-image">{results.back ? "Generating Side..." : "Waiting..."}</div>}
              <div className="label">Right Side View</div>
            </div>
            <div className="result-card">
              {results.left ? <img src={results.left} alt="Sitting View" /> : <div className="skeleton-image">{results.right ? "Generating Sitting..." : "Waiting..."}</div>}
              <div className="label">Sitting View</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
