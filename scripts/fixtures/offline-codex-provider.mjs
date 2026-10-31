#!/usr/bin/env node
// The previous workflow scenario adapter was retired. Generic SDK tests supply
// their own bounded JSONL provider; no execution format is synthesized here.
throw Object.assign(new Error('Offline workflow scenario producer is unavailable'),{code:'CURRENT_FIXTURE_UNAVAILABLE'});
