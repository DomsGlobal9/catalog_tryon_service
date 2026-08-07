async function testApi() {
  console.log("=========================================");
  console.log("📤 SENDING PAYLOAD TO API...");
  console.log("=========================================\n");
  
  const payload = {
    clientId: "test-vendor-999",
    modelId: "model1",
    fullDress: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQE...", // Shortened Base64 for the test
    topFront: null,
    topBack: null,
    bottom: null
  };
  
  console.log(JSON.stringify(payload, null, 2));
  
  console.log("\n⏳ Waiting for AI Generation (Simulated 5 seconds)...\n");
  
  try {
    const response = await fetch("http://localhost:4005/api/v1/draping/generate-catalog", {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-api-key': 'se_catalog_internal_key_v1_99283'
      },
      body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    
    console.log("=========================================");
    console.log("📥 RECEIVED RESPONSE FROM API...");
    console.log("=========================================\n");
    console.log(JSON.stringify(data, null, 2));
    
  } catch (err) {
    console.error("Test failed:", err.message);
  }
}

testApi();
