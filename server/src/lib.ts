// Package entry point for @skateman/tankstelle.
// Consumers (e.g. the nexus Azure Functions host) import createApp and drive
// it via the Web-standard `app.fetch(request)` interface.
export { createApp } from './app.js';
