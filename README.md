# myCALL — Medicare Call Intelligence

**Automatically transcribe web calls, extract Medicare enrollment data, and push to your CRM.**

Zero manual data entry. Real-time compliance monitoring. Works in Chrome, Edge, Brave, and Firefox.

## What It Does

1. Captures your web call audio with one click (browser extension)
2. Transcribes in real-time with speaker separation (Deepgram Nova-2)
3. Extracts structured Medicare data via Claude AI
4. Checks CMS compliance automatically
5. Pushes to GoHighLevel CRM
6. Scores the call 0-100 with coaching recommendations

## Quick Start

See docs/INSTALL.md for browser install instructions.

### Backend
```
cd backend
pip install -r requirements.txt
cp ../.env.example ../.env
uvicorn main:app --reload
```

## Browser Support

- Chrome: Full support
- Edge: Full support
- Brave: Full support (via Chrome Web Store)
- Firefox: Partial (tabCapture limitations)

## License

Proprietary — theBRIDGE / INSUREitALL