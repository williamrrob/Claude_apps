#!/usr/bin/env node
/**
 * Etymology Request API
 * Handles user requests for M-W etymology verification from the app
 */
const fs = require('fs');
const path = require('path');

const requestsPath = './etymology_requests.json';

// Ensure requests file exists
if (!fs.existsSync(requestsPath)) {
  fs.writeFileSync(requestsPath, JSON.stringify({
    requests: [],
    metadata: {
      total_requests: 0,
      completed: 0,
      pending: 0,
      failed: 0,
      last_updated: new Date().toISOString()
    }
  }, null, 2));
}

/**
 * API Endpoint: Submit etymology request
 * Called by app when user clicks "Request Etymology"
 */
function submitEtymologyRequest(word) {
  const requests = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));

  // Check if word already exists in curated data
  const curated = JSON.parse(fs.readFileSync('./curated_morphemes_complete.json', 'utf8'));
  if (curated[word] && curated[word].mwVerified) {
    return {
      status: 'already_verified',
      message: `${word} already has M-W verified etymology`,
      data: curated[word]
    };
  }

  // Check if request already exists
  const existing = requests.requests.find(r => r.word === word);
  if (existing) {
    return {
      status: existing.status,
      message: `Request for "${word}" is already ${existing.status}`,
      request_id: existing.id
    };
  }

  // Create new request
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const request = {
    id: requestId,
    word: word,
    status: 'pending',
    requested_at: new Date().toISOString(),
    requested_by: 'app_user',
    etymology: null,
    morpheme_breakdown: null,
    mw_verified: false,
    notes: null
  };

  requests.requests.push(request);
  requests.metadata.total_requests++;
  requests.metadata.pending++;
  requests.metadata.last_updated = new Date().toISOString();

  fs.writeFileSync(requestsPath, JSON.stringify(requests, null, 2));

  console.log(`✓ New etymology request: ${word} (ID: ${requestId})`);

  return {
    status: 'submitted',
    message: `Etymology request submitted for "${word}"`,
    request_id: requestId,
    position_in_queue: requests.requests.filter(r => r.status === 'pending').length
  };
}

/**
 * Get pending requests for processing
 */
function getPendingRequests() {
  const requests = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  return requests.requests.filter(r => r.status === 'pending').slice(0, 10);
}

/**
 * Check request status
 */
function checkRequestStatus(requestId) {
  const requests = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  const request = requests.requests.find(r => r.id === requestId);

  if (!request) {
    return { status: 'not_found', message: 'Request ID not found' };
  }

  return {
    status: request.status,
    word: request.word,
    data: request.etymology ? {
      etymology: request.etymology,
      morpheme_breakdown: request.morpheme_breakdown,
      notes: request.notes
    } : null,
    requested_at: request.requested_at,
    completed_at: request.completed_at
  };
}

/**
 * Get all requests (admin view)
 */
function getAllRequests() {
  const requests = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  return {
    metadata: requests.metadata,
    by_status: {
      pending: requests.requests.filter(r => r.status === 'pending').length,
      processing: requests.requests.filter(r => r.status === 'processing').length,
      completed: requests.requests.filter(r => r.status === 'completed').length,
      failed: requests.requests.filter(r => r.status === 'failed').length
    },
    recent_requests: requests.requests.slice(-20)
  };
}

// Export for use in other scripts
module.exports = {
  submitEtymologyRequest,
  getPendingRequests,
  checkRequestStatus,
  getAllRequests
};

// CLI interface
if (require.main === module) {
  const command = process.argv[2];
  const word = process.argv[3];

  switch(command) {
    case 'submit':
      console.log(JSON.stringify(submitEtymologyRequest(word), null, 2));
      break;
    case 'pending':
      console.log(JSON.stringify(getPendingRequests(), null, 2));
      break;
    case 'status':
      console.log(JSON.stringify(checkRequestStatus(word), null, 2));
      break;
    case 'all':
      console.log(JSON.stringify(getAllRequests(), null, 2));
      break;
    default:
      console.log(`
Etymology Request API - CLI Interface

Usage:
  node etymology_request_api.js submit <word>     - Submit request for word
  node etymology_request_api.js pending           - Get pending requests
  node etymology_request_api.js status <req_id>   - Check request status
  node etymology_request_api.js all               - Get all requests

Examples:
  node etymology_request_api.js submit elephant
  node etymology_request_api.js pending
  node etymology_request_api.js status req_1234567890_abc123
      `);
  }
}
