#!/usr/bin/env node
/**
 * Process pending etymology requests
 * Monitors requests.json for pending items and processes them
 * Adds verified etymologies to curated data and word shards
 */
const fs = require('fs');
const path = require('path');

const requestsPath = './etymology_requests.json';
const curatedPath = './curated_morphemes_complete.json';
const wordsDir = './words';

/**
 * Update request status
 */
function updateRequestStatus(requestId, status, data = {}) {
  const requests = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  const request = requests.requests.find(r => r.id === requestId);

  if (request) {
    request.status = status;
    if (status === 'processing') {
      request.started_at = new Date().toISOString();
    } else if (status === 'completed' || status === 'failed') {
      request.completed_at = new Date().toISOString();
    }

    Object.assign(request, data);
  }

  // Update metadata
  requests.metadata.pending = requests.requests.filter(r => r.status === 'pending').length;
  requests.metadata.processing = requests.requests.filter(r => r.status === 'processing').length;
  requests.metadata.completed = requests.requests.filter(r => r.status === 'completed').length;
  requests.metadata.failed = requests.requests.filter(r => r.status === 'failed').length;
  requests.metadata.last_updated = new Date().toISOString();

  fs.writeFileSync(requestsPath, JSON.stringify(requests, null, 2));
}

/**
 * Add verified etymology to curated data
 */
function addToCuratedData(word, etymologyData) {
  const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));

  if (curated[word]) {
    // Update existing entry
    curated[word].mwEtymology = etymologyData.etymology;
    curated[word].mwVerified = true;
    curated[word].source = 'M-W verified (user request)';
    if (etymologyData.morpheme_breakdown) {
      curated[word].parts = etymologyData.morpheme_breakdown.parts;
    }
  } else {
    // Create new entry
    curated[word] = {
      parts: etymologyData.morpheme_breakdown?.parts || [],
      root: etymologyData.morpheme_breakdown?.root || word,
      mwEtymology: etymologyData.etymology,
      mwVerified: true,
      source: 'M-W verified (user request)',
      verified_date: new Date().toISOString()
    };
  }

  fs.writeFileSync(curatedPath, JSON.stringify(curated, null, 2));
}

/**
 * Update word shard with etymology
 */
function updateWordShard(word, etymologyData) {
  const firstTwoLetters = word.substring(0, 2).toLowerCase();
  const shardPath = path.join(wordsDir, `${firstTwoLetters}.json`);

  if (!fs.existsSync(shardPath)) {
    return;
  }

  const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));

  if (shard[word]) {
    // Add morpheme data
    if (!shard[word].m) {
      shard[word].m = {};
    }
    shard[word].m.verified = true;
    shard[word].m.source = 'M-W verified (user request)';

    if (etymologyData.morpheme_breakdown) {
      shard[word].m.parts = etymologyData.morpheme_breakdown.parts;
      shard[word].m.root = etymologyData.morpheme_breakdown.root;
    }

    if (etymologyData.etymology) {
      shard[word].m.etymology = etymologyData.etymology;
    }

    fs.writeFileSync(shardPath, JSON.stringify(shard, null, 2));
  }
}

/**
 * Process a single request
 * This is where you would research the word and add etymology
 */
function processRequest(request) {
  console.log(`\nProcessing: ${request.word} (ID: ${request.id})`);
  console.log('================================================================================');

  updateRequestStatus(request.id, 'processing');

  // PLACEHOLDER: Research word on M-W here
  // In actual use, you would:
  // 1. Go to merriam-webster.com/dictionary/[word]
  // 2. Extract etymology from "History and Etymology" section
  // 3. Parse morpheme breakdown
  // 4. Return results

  // For now, show what needs to be filled in:
  const etymologyTemplate = {
    word: request.word,
    etymology: 'FILL_IN: M-W etymology text here',
    morpheme_breakdown: {
      parts: [
        // FILL_IN: Add morpheme parts
        // { id: 'root', kind: 'root', gloss: 'meaning', surface: 'form' }
      ],
      root: 'FILL_IN: root family'
    },
    mw_link: `https://www.merriam-webster.com/dictionary/${request.word}`,
    notes: 'FILL_IN: Any special notes about this word'
  };

  console.log('\n📋 REQUEST TEMPLATE TO FILL IN:\n');
  console.log(JSON.stringify(etymologyTemplate, null, 2));

  console.log(`\n📍 NEXT STEP: Research ${request.word} on M-W and fill in above template`);
  console.log(`🔗 Link: https://www.merriam-webster.com/dictionary/${request.word}\n`);

  // For demo, mark as "needs_research" instead of completed
  updateRequestStatus(request.id, 'needs_research', {
    etymology: null,
    morpheme_breakdown: null,
    notes: 'Awaiting M-W research'
  });

  return etymologyTemplate;
}

/**
 * Submit completed research
 */
function submitResearch(requestId, etymologyData) {
  const requests = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  const request = requests.requests.find(r => r.id === requestId);

  if (!request) {
    return { status: 'error', message: 'Request not found' };
  }

  console.log(`\n✓ Submitting research for: ${request.word}`);

  // Add to curated data
  addToCuratedData(request.word, etymologyData);

  // Update word shard
  updateWordShard(request.word, etymologyData);

  // Mark request as completed
  updateRequestStatus(requestId, 'completed', {
    etymology: etymologyData.etymology,
    morpheme_breakdown: etymologyData.morpheme_breakdown,
    notes: etymologyData.notes
  });

  console.log(`✓ Added ${request.word} to curated data`);
  console.log(`✓ Updated word shards`);
  console.log(`✓ Request marked as completed\n`);

  return {
    status: 'completed',
    message: `Etymology for "${request.word}" verified and added to database`,
    word: request.word
  };
}

/**
 * Get pending requests for processing
 */
function getPendingRequests() {
  const requests = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  return requests.requests.filter(r => r.status === 'pending');
}

// Export functions
module.exports = {
  processRequest,
  submitResearch,
  getPendingRequests,
  updateRequestStatus
};

// CLI interface
if (require.main === module) {
  const command = process.argv[2];

  if (command === 'monitor') {
    console.log(`
================================================================================
ETYMOLOGY REQUEST MONITOR
================================================================================

Checking for pending requests...\n`);

    const pending = getPendingRequests();

    if (pending.length === 0) {
      console.log('✓ No pending requests');
    } else {
      console.log(`Found ${pending.length} pending request(s):\n`);
      pending.forEach(req => {
        console.log(`  📝 ${req.word} (ID: ${req.id}) - Requested: ${req.requested_at}`);
      });

      console.log(`\n💡 To process next request, run:`);
      console.log(`   node process_etymology_requests.js process ${pending[0].id}\n`);
    }
  } else if (command === 'process') {
    const requestId = process.argv[3];
    const requests = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
    const request = requests.requests.find(r => r.id === requestId);

    if (!request) {
      console.log('Request not found');
      return;
    }

    processRequest(request);
  } else if (command === 'submit') {
    const requestId = process.argv[3];
    // Read etymology data from stdin or file
    // For now, show usage
    console.log(`
Usage: node process_etymology_requests.js submit <request_id> <json_file>

Example:
  Create a file 'etymology_data.json' with:
  {
    "etymology": "Latin ...",
    "morpheme_breakdown": {
      "parts": [...],
      "root": "..."
    },
    "notes": "..."
  }

Then run:
  node process_etymology_requests.js submit <request_id> etymology_data.json
    `);
  } else {
    console.log(`
REQUEST PROCESSOR - CLI Interface

Usage:
  node process_etymology_requests.js monitor           - Check for pending requests
  node process_etymology_requests.js process <req_id>  - Process specific request
  node process_etymology_requests.js submit <req_id>   - Submit completed research

WORKFLOW:
1. monitor     → See what's pending
2. process     → Research word on M-W, follow template
3. submit      → Add verified etymology to database

Example:
  node process_etymology_requests.js monitor
  node process_etymology_requests.js process req_1234567890_abc123
    `);
  }
}
