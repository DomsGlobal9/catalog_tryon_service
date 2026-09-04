import { useState } from 'react';
import WomenApp from './WomenApp.jsx';
import MenApp from './MenApp.jsx';
import DiscoveryApp from './DiscoveryApp.jsx';
import './discovery.css';

/**
 * Test harness shell. Three capabilities live behind the same service and the
 * same API key, so this landing screen picks which flow to exercise:
 *
 *   Women's Catalog  -> /api/v1/draping/generate-catalog  (category: women)
 *   Men's Catalog    -> /api/v1/draping/generate-catalog  (category: men)
 *   Design Discovery -> /api/v1/discovery/*
 *
 * The men and women views are surfaced here directly rather than behind a second
 * switcher inside App.jsx, so every capability is one click from the landing
 * page. App.jsx remains as a standalone women/men toggle for anyone rendering it
 * on its own.
 */
export default function Root() {
  const [view, setView] = useState('home');

  if (view === 'home') return <Home onPick={setView} />;

  const Current = view === 'women' ? WomenApp : view === 'men' ? MenApp : DiscoveryApp;

  return (
    <div>
      <button className="disc-back" onClick={() => setView('home')}>← Back</button>
      <Current />
    </div>
  );
}

function Home({ onPick }) {
  return (
    <div className="home-wrap">
      <header className="home-header">
        <h1>ScaleEasy Catalog Service</h1>
        <p>Three capabilities behind one service. Pick one to test.</p>
      </header>

      <div className="home-grid">
        <button className="home-card" onClick={() => onPick('women')}>
          <span className="home-icon">👗</span>
          <h2>Women’s Catalog</h2>
          <p>Upload a saree, lehenga, anarkali, sharara or kurti and generate a 4-view AI catalog — front, back, side and sitting — streamed live over SSE.</p>
          <code>POST /api/v1/draping/generate-catalog</code>
        </button>

        <button className="home-card" onClick={() => onPick('men')}>
          <span className="home-icon">👔</span>
          <h2>Men’s Catalog</h2>
          <p>Formals, blazers, kurta pajama and sherwani — plus size recommendation and try-on against a supplied user photo.</p>
          <code>category: "men"</code>
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
