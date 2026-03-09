const { AppServer, AppSession } = require('@mentra/sdk');
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (_req, res) => res.status(200).send('OK - Picture Detector running!'));

// Webhook receiver (optional, for any external calls)
app.post('/webhook', (req, res) => {
  console.log('Webhook received:', req.body);
  res.status(200).send('OK');
});

const server = new AppServer({
  packageName: 'com.yakov.picture.detector', // Updated Mentra package name
  apiKey: process.env.MENTRA_API_KEY, // Loaded from env
  port: process.env.PORT || 3000 // For Railway dynamic port
});

// Handle new sessions (app activation)
server.onSession = async (session, sessionId, userId) => {
  console.log(`Session started: ${sessionId} (user: ${userId})`);

  try {
    // Capture photo from glasses
    const photo = await session.camera.requestPhoto({
      metadata: { reason: 'facial_recognition' }
    });

    const imageBytes = Buffer.from(photo.photoData);
    const base64Image = imageBytes.toString('base64');

    // Send to Face++ for analysis
    const response = await axios.post('https://api-us.faceplusplus.com/facepp/v3/detect', null, {
      params: {
        api_key: process.env.FACEPP_API_KEY,
        api_secret: process.env.FACEPP_API_SECRET,
        image_base64: base64Image,
        return_attributes: 'age,gender,emotion,beauty'
      }
    });

    // Process results
    const faces = response.data.faces || [];
    let resultText = 'Detected faces: ';
    if (faces.length === 0) {
      resultText += 'None';
    } else {
      faces.forEach((face, index) => {
        const attrs = face.attributes;
        const age = attrs.age?.value || 'Unknown';
        const gender = attrs.gender?.value || 'Unknown';
        const emotion = Object.keys(attrs.emotion).reduce((a, b) => attrs.emotion[a] > attrs.emotion[b] ? a : b, 'neutrality');
        resultText += `\nFace ${index + 1}: Age ${age}, Gender: ${gender}, Emotion: ${emotion}`;
      });
    }

    // Send results to glasses HUD/phone
    await session.display.sendText(resultText);

  } catch (error) {
    console.error('Error:', error);
    await session.display.sendText('Error analyzing photo.');
  }
};

// Start the server
server.start().then(() => console.log(`Server running on port ${process.env.PORT || 3000}`));
