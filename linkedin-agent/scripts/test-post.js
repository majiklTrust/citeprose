#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Test Post Generator — Preview content without publishing
// Run: npm run test-post
// ═══════════════════════════════════════════════════════════════

import "dotenv/config";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(__dirname, "../data"), { recursive: true });

const { initDatabase } = await import("../src/services/database.js");
initDatabase();

const { generatePost, qualityCheck } = await import("../src/services/content-generator.js");
const { TOPICS } = await import("../src/config/topics.js");
const { canPostNow } = await import("../src/services/scheduler.js");

console.log("\n🧪 LinkedIn AI Agent — Test Post Generator\n");
console.log("─".repeat(60));

// Show cadence status
const cadence = canPostNow();
console.log(`\n📊 Cadence Check: ${cadence.allowed ? "✅ Can post now" : `⏳ ${cadence.reason}`}\n`);

// Generate a post
console.log("⚙️  Generating content...\n");

try {
  const post = await generatePost();
  const quality = await qualityCheck(post.content);

  console.log("─".repeat(60));
  console.log(`📌 Topic:    ${TOPICS.find(t => t.id === post.topicId)?.name}`);
  console.log(`📝 Title:    ${post.title}`);
  console.log(`🎯 Angle:    ${post.angle}`);
  console.log("─".repeat(60));
  console.log("\n" + post.content);
  console.log("\n" + post.hashtags.join(" "));
  console.log("\n" + "─".repeat(60));
  console.log("\n📊 Quality Scores:");
  for (const [key, val] of Object.entries(quality.scores || {})) {
    const bar = "█".repeat(val) + "░".repeat(10 - val);
    console.log(`   ${key.padEnd(22)} ${bar} ${val}/10`);
  }
  console.log(`\n   Overall: ${quality.overall}/10 — ${quality.pass ? "✅ PASS" : "❌ NEEDS WORK"}`);
  if (quality.feedback) {
    console.log(`   Feedback: ${quality.feedback}`);
  }
  console.log("\n" + "─".repeat(60));
  console.log(`\n📏 Word count: ${post.content.split(/\s+/).length}`);
  console.log(`📏 Character count: ${post.content.length}`);
  console.log("\n✅ This was a TEST — nothing was posted to LinkedIn.\n");

} catch (err) {
  console.error("❌ Generation failed:", err.message);
  console.error(err.stack);
  process.exit(1);
}
