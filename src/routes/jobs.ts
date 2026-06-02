import { Router } from 'express';
import { requireApiKey } from '../index.js';
import { getJob } from '../services/jobStore.js';

export const jobsRouter = Router();

jobsRouter.get('/jobs/:jobId', requireApiKey, (req, res) => {
  const job = getJob(req.params.jobId);

  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }

  res.json({ success: true, ...job });
});
