import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { normalizeTokenEvent } from '../utils/tokenFeed';

const DEFAULT_DURATION_MINUTES = 10;
const MAX_TRACKED_MINTS = 250;

function getDurationMinutes(): number {
    const raw = process.env.PAPER_CAPTURE_MINUTES || process.argv[2];
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_DURATION_MINUTES;
    }

    return Math.min(120, parsed);
}

function main(): void {
    const durationMinutes = getDurationMinutes();
    const startedAt = new Date();
    const outputDir = path.resolve(process.cwd(), 'runtime', 'captures');
    fs.mkdirSync(outputDir, { recursive: true });

    const fileName = `${startedAt.toISOString().replace(/[:.]/g, '-')}.jsonl`;
    const outputPath = path.join(outputDir, fileName);
    const stream = fs.createWriteStream(outputPath, { flags: 'a' });
    const trackedMints = new Set<string>();
    let sequence = 0;
    let capturedEvents = 0;
    let launchCount = 0;

    console.log(`Capturing PumpPortal launch tape for ${durationMinutes} minute(s) -> ${outputPath}`);
    stream.write(`${JSON.stringify({
        type: 'session',
        startedAt: startedAt.toISOString(),
        durationMinutes
    })}\n`);

    const ws = new WebSocket('wss://pumpportal.fun/api/data');
    const stopTimer = setTimeout(() => {
        console.log('Capture window elapsed, closing feed.');
        ws.close();
    }, durationMinutes * 60_000);

    ws.on('open', () => {
        console.log('Feed connected.');
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', (rawData) => {
        const payload = typeof rawData === 'string' ? rawData : rawData.toString();

        try {
            const parsed = JSON.parse(payload);
            const normalized = parsed?.mint ? normalizeTokenEvent(parsed, Date.now()) : null;
            const event = {
                type: 'event',
                sequence: ++sequence,
                capturedAt: new Date().toISOString(),
                raw: parsed,
                normalized
            };
            stream.write(`${JSON.stringify(event)}\n`);
            capturedEvents += 1;

            if (parsed?.mint && parsed?.txType === 'create' && !trackedMints.has(parsed.mint)) {
                if (trackedMints.size >= MAX_TRACKED_MINTS) {
                    return;
                }

                trackedMints.add(parsed.mint);
                launchCount += 1;
                ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [parsed.mint] }));
            }
        } catch {
            // Ignore malformed frames from the feed.
        }
    });

    ws.on('error', (error) => {
        console.error(`Feed error: ${error.message}`);
        clearTimeout(stopTimer);
        stream.end();
    });

    ws.on('close', () => {
        clearTimeout(stopTimer);
        stream.end();
        console.log(`Feed closed. Captured ${capturedEvents} events across ${launchCount} launch(es).`);
    });
}

main();
