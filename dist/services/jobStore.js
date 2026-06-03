"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJob = createJob;
exports.getJob = getJob;
exports.markJobSucceeded = markJobSucceeded;
exports.markJobFailed = markJobFailed;
const jobs = new Map();
function createJob(jobId, queryCount) {
    const job = {
        jobId,
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        queryCount,
        itemCount: 0,
        insertedCount: 0,
        errorMessage: null,
        sampleItems: [],
    };
    jobs.set(jobId, job);
    return job;
}
function getJob(jobId) {
    return jobs.get(jobId);
}
function markJobSucceeded(jobId, products, insertedCount) {
    const job = requireJob(jobId);
    job.status = 'SUCCEEDED';
    job.finishedAt = new Date().toISOString();
    job.itemCount = products.length;
    job.insertedCount = insertedCount;
    job.sampleItems = products.slice(0, 10);
    jobs.set(jobId, job);
    return job;
}
function markJobFailed(jobId, error) {
    const job = requireJob(jobId);
    job.status = 'FAILED';
    job.finishedAt = new Date().toISOString();
    job.errorMessage = error instanceof Error ? error.message : String(error);
    jobs.set(jobId, job);
    return job;
}
function requireJob(jobId) {
    const job = jobs.get(jobId);
    if (!job)
        throw new Error(`Job not found: ${jobId}`);
    return job;
}
