import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { OnnxEmbedder } from '../src/brain/embedder.js';
import { BrainStore } from '../src/brain/store.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const modelPath = join(repoRoot, 'models', 'embed', 'model.onnx');
const tokenizerPath = join(repoRoot, 'models', 'embed', 'tokenizer.json');
const modelsPresent = existsSync(modelPath) && existsSync(tokenizerPath);

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are L2-normalized
}

// Real-model integration tests: skipped only when models/embed has not been fetched.
describe.skipIf(!modelsPresent)('OnnxEmbedder (real bge-small-en-v1.5)', () => {
  const embedder = new OnnxEmbedder({ modelPath, tokenizerPath });

  afterAll(async () => {
    await embedder.dispose();
  });

  it('produces 384-dim L2-normalized vectors', { timeout: 60_000 }, async () => {
    expect(embedder.dim).toBe(384);
    const [vec] = await embedder.embed(['hello world']);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec!.length).toBe(384);
    let norm = 0;
    for (const x of vec!) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
  });

  it('paraphrases score high cosine, unrelated sentences score low', { timeout: 60_000 }, async () => {
    const [a, b, c] = await embedder.embed([
      'The weather today is sunny and warm.',
      'It is a warm, sunny day outside.',
      'The quarterly financial report shows a decline in revenue.'
    ]);
    const para = cosine(a!, b!);
    const unrelated = cosine(a!, c!);
    expect(para).toBeGreaterThan(0.85);
    expect(unrelated).toBeLessThan(0.75);
    expect(para - unrelated).toBeGreaterThan(0.15);
  });

  it('batching yields the same embeddings as one large batch', { timeout: 60_000 }, async () => {
    const texts = [
      'Alpha likes apples.',
      'Beta bakes bread every Sunday morning.',
      'Gamma is planning a trip to Norway.',
      'Delta fixed the leaking kitchen tap.',
      'Epsilon reads science fiction before bed.'
    ];
    const small = new OnnxEmbedder({ modelPath, tokenizerPath, batchSize: 2 });
    try {
      const batched = await small.embed(texts);
      const single = await embedder.embed(texts);
      expect(batched).toHaveLength(5);
      for (let i = 0; i < texts.length; i++) {
        // Padding differences cause only tiny numeric drift.
        expect(cosine(batched[i]!, single[i]!)).toBeGreaterThan(0.999);
      }
    } finally {
      await small.dispose();
    }
  });

  it('acceptance: ~20-note vault returns sane semantic neighbors', { timeout: 120_000 }, async () => {
    const base = mkdtempSync(join(tmpdir(), 'jarvis-brain-onnx-'));
    const store = new BrainStore({
      vaultDir: join(base, 'vault'),
      indexDir: join(base, 'index'),
      embedder
    });
    try {
      const seeds: [string, string][] = [
        ['Coffee brewing method', 'I brew coffee with a V60 every morning: 15g of beans, medium grind, water at 93 degrees.'],
        ['Espresso machine wishlist', 'Considering a used Gaggia Classic Pro for making espresso at home.'],
        ['Gym routine', 'Strength training three times a week: squats, bench press, deadlifts.'],
        ['Running plan', 'Building up to a 10k run in under 55 minutes by October.'],
        ['Thesis deadline', 'The master thesis draft is due to my supervisor on September 1st.'],
        ['Thesis topic', 'Thesis explores retrieval-augmented generation for personal assistants.'],
        ['Car maintenance', 'The Corolla needs an oil change and new wiper blades before winter.'],
        ['Bike repair', 'Rear derailleur is misaligned; take the bike to the shop on Saturday.'],
        ['Trip to Japan', 'Planning two weeks in Japan next spring: Tokyo, Kyoto, and Osaka.'],
        ['Weekend hike', 'Hike the coastal trail with Sam next weekend if the weather holds.'],
        ['Mum birthday gift', 'Mum turns 60 in November; she mentioned wanting a pottery class.'],
        ['Dinner party menu', 'Cook mushroom risotto and tiramisu for the dinner party on Friday.'],
        ['Sourdough starter', 'Feed the sourdough starter daily; bake a loaf every Sunday.'],
        ['Budget note', 'Monthly savings target is 400 euros; cut back on takeaway.'],
        ['Tax return', 'File the annual tax return before the end of April.'],
        ['Book recommendation', 'Ana recommended reading The Left Hand of Darkness by Le Guin.'],
        ['Spanish practice', 'Do 20 minutes of Spanish practice on Duolingo every evening.'],
        ['Meeting with advisor', 'Advisor meeting moved to Thursdays at 14:00 in room B412.'],
        ['Houseplant care', 'Water the monstera weekly; the fern prefers misting every other day.'],
        ['Password hint', 'Router admin password hint: the usual phrase plus the flat number.']
      ];
      for (const [title, body] of seeds) {
        await store.add({ title, body, tags: [], source: 'manual' });
      }
      expect((await store.recent(50)).length).toBe(seeds.length);

      const query = 'what is my morning caffeine routine?';
      const hits = await store.search(query, { k: 5 });
      // Log the demo for the acceptance report.
      console.log(`\nacceptance query: "${query}"`);
      for (const h of hits) {
        console.log(`  ${h.score.toFixed(3)}  ${h.note.title} — ${h.snippet.slice(0, 60)}`);
      }
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.note.title).toBe('Coffee brewing method');

      const query2 = 'when do I have to hand in my dissertation?';
      const hits2 = await store.search(query2, { k: 5 });
      console.log(`acceptance query: "${query2}"`);
      for (const h of hits2) {
        console.log(`  ${h.score.toFixed(3)}  ${h.note.title} — ${h.snippet.slice(0, 60)}`);
      }
      expect(hits2[0]!.note.title).toMatch(/^Thesis/);
    } finally {
      store.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
