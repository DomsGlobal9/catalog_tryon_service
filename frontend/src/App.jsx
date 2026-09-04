import { useState } from 'react';
import WomenApp from './WomenApp';
import MenApp from './MenApp';

function App() {
  const [selectedFlow, setSelectedFlow] = useState('women');

  return (
    <div>
      <div style={{ textAlign: 'center', padding: '20px', background: '#1e1b4b', color: '#fff', borderBottom: '2px solid #312e81' }}>
        <h2 style={{ margin: 0, marginBottom: '10px' }}>Select Try-On Category</h2>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px' }}>
          <button 
            style={{ 
              padding: '10px 20px', 
              fontSize: '16px', 
              cursor: 'pointer',
              background: selectedFlow === 'women' ? '#6366f1' : '#312e81',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontWeight: 'bold',
              transition: 'background 0.2s'
            }}
            onClick={() => setSelectedFlow('women')}
          >
            WOMEN
          </button>
          <button 
            style={{ 
              padding: '10px 20px', 
              fontSize: '16px', 
              cursor: 'pointer',
              background: selectedFlow === 'men' ? '#6366f1' : '#312e81',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontWeight: 'bold',
              transition: 'background 0.2s'
            }}
            onClick={() => setSelectedFlow('men')}
          >
            MEN
          </button>
        </div>
      </div>
      
      {selectedFlow === 'women' ? <WomenApp /> : <MenApp />}
    </div>
  );
}

export default App;
