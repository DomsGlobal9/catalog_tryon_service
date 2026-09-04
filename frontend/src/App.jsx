import { useState } from 'react';
import WomenApp from './WomenApp';
import MenApp from './MenApp';

/**
 * Standalone women/men toggle.
 *
 * Root.jsx surfaces both views on its landing page directly, so this component
 * is not used by the harness - it is kept for anyone rendering App on its own.
 * Restyled from hardcoded inline colours to the shared theme classes so it
 * matches the rest of the product wherever it is used.
 */
function App() {
  const [selectedFlow, setSelectedFlow] = useState('women');

  return (
    <div>
      <div className="flow-switch">
        <h2>Select Try-On Category</h2>
        <div className="flow-switch-buttons">
          {['women', 'men'].map((flow) => (
            <button
              key={flow}
              className={'disc-mode' + (selectedFlow === flow ? ' active' : '')}
              onClick={() => setSelectedFlow(flow)}
            >
              {flow.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {selectedFlow === 'women' ? <WomenApp /> : <MenApp />}
    </div>
  );
}

export default App;
