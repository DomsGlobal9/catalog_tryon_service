import { useState } from 'react';
import App from './App.jsx';
import DiscoveryApp from './DiscoveryApp.jsx';
import './discovery.css';

/**
 * Test harness shell. Two capabilities live behind the same service and the same
 * API key, so this landing screen just picks which flow to exercise:
 *
 *   Catalog Try-On   -> /api/v1/draping/generate-catalog   (existing App.jsx)
 *   Design Discovery -> /api/v1/discovery/*                (DiscoveryApp.jsx)
 *
 * App.jsx is untouched - it is rendered exactly as before.
 */
export default function Root() {
  const [view, setView] = useState('home');

  if (view === 'home') return <Home onPick={setView} />;

  return (
    <div>
      <button className="disc-back" onClick={() => setView('home')}>← Back</button>
      {view === 'catalog' ? <App /> : <DiscoveryApp />}
    </div>
  );
}

function Home({ onPick }) {
  return (
    <div className="home-wrap">
      <header className="home-header">
        <h1>ScaleEasy Catalog Service</h1>
        <p>Two independent capabilities behind one service. Pick one to test.</p>
      </header>

      <div className="home-grid">
        <button className="home-card" onClick={() => onPick('catalog')}>
          <span className="home-icon">👗</span>
          <h2>Catalog Try-On</h2>
          <p>Upload garment images and generate a 4-view AI catalog — front, back, side and sitting — streamed back live over SSE.</p>
          <code>POST /api/v1/draping/generate-catalog</code>
        </button>

        <button className="home-card" onClick={() => onPick('discovery')}>
          <span className="home-icon">🔎</span>
          <h2>Design Discovery</h2>
          <p>Search the web for garment design references by keyword, by garment and design area, or with one line of natural language.</p>
          <code>POST /api/v1/discovery/search</code>
        </button>
      </div>

      <p className="home-note">
        Discovery is browse-only: it returns individual image URLs with their source pages and never
        downloads, stores or generates anything.
      </p>
    </div>
  );
}
