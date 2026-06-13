// Admin surface entry point. Enforces role=admin + AAL2, routes every /admin/*
// endpoint, renders errors as RFC 9457 problem+json, and audits every call.

import { corsHeaders, ok, problem, ProblemError, notFound } from './lib/http.ts';
import { requireAdmin, type AdminContext } from './lib/auth.ts';
import { writeAudit } from './lib/audit.ts';
import * as prompts from './routes/prompts.ts';
import * as models from './routes/models.ts';
import * as jobs from './routes/jobs.ts';
import * as trips from './routes/trips.ts';
import * as customers from './routes/customers.ts';
import * as review from './routes/content-review.ts';
import * as commerce from './routes/commerce.ts';

// Reduce the request path to the part after `/admin`, then split into segments.
function adminSegments(url: URL): string[] {
  const marker = '/admin';
  const i = url.pathname.indexOf(marker);
  const sub = i === -1 ? url.pathname : url.pathname.slice(i + marker.length);
  return sub.split('/').filter((s) => s.length > 0);
}

async function route(
  method: string,
  seg: string[],
  req: Request,
  ctx: AdminContext,
): Promise<Response> {
  const [resource, a, b] = seg;

  switch (resource) {
    case 'me':
      // The caller is already proven admin + AAL2 by requireAdmin; echo the
      // resolved session so the Admin app gets a client-readable signal.
      if (!a && method === 'GET') {
        return ok({ userId: ctx.actorId, email: ctx.email, role: 'admin', mfaVerified: true });
      }
      break;

    case 'prompts':
      if (!a) {
        if (method === 'GET') return prompts.listPrompts(req, ctx);
        if (method === 'POST') return prompts.createPrompt(req, ctx);
      } else if (!b) {
        if (method === 'GET') return prompts.getPrompt(req, ctx, a);
      } else if (b === 'versions' && method === 'POST') {
        return prompts.createPromptVersion(req, ctx, a);
      } else if (b === 'activate' && method === 'POST') {
        return prompts.activatePrompt(req, ctx, a);
      } else if (b === 'diff' && method === 'GET') {
        return prompts.diffPrompt(req, ctx, a);
      }
      break;

    case 'models':
      if (!a && method === 'GET') return models.listModels(req, ctx);
      break;

    case 'model-routes':
      if (!a && method === 'GET') return models.listModelRoutes(req, ctx);
      if (a && method === 'PUT') return models.setModelRoute(req, ctx, a);
      break;

    case 'jobs':
      if (!a && method === 'GET') return jobs.listJobs(req, ctx);
      if (a === 'cap' && method === 'GET') return jobs.getJobCap(req, ctx);
      if (a && !b && method === 'GET') return jobs.getJob(req, ctx, a);
      if (a && b === 'retry' && method === 'POST') return jobs.retryJob(req, ctx, a);
      break;

    case 'trips':
      if (!a && method === 'GET') return trips.searchTrips(req, ctx);
      if (a && !b && method === 'GET') return trips.getTripSummary(req, ctx, a);
      if (a && b === 'content' && method === 'GET') return trips.getTripContent(req, ctx, a);
      if (a && b === 'profiles' && method === 'GET') return trips.getTripProfiles(req, ctx, a);
      if (a && b === 'progress' && method === 'GET') return trips.getTripProgress(req, ctx, a);
      break;

    case 'customers':
      if (!a && method === 'GET') return customers.searchCustomers(req, ctx);
      if (a && b === 'deletion-request' && method === 'POST') {
        return customers.requestCustomerDeletion(req, ctx, a);
      }
      break;

    case 'content-review':
      if (!a && method === 'GET') return review.listContentReview(req, ctx);
      if (a && b === 'approve' && method === 'POST') return review.approveContent(req, ctx, a);
      if (a && b === 'edit' && method === 'POST') return review.editContent(req, ctx, a);
      break;

    case 'products':
      if (!a) {
        if (method === 'GET') return commerce.listProducts(req, ctx);
        if (method === 'POST') return commerce.createProduct(req, ctx);
      } else if (!b) {
        if (method === 'PATCH') return commerce.updateProduct(req, ctx, a);
      }
      break;

    case 'purchases':
      if (!a && method === 'GET') return commerce.listPurchases(req, ctx);
      break;
  }

  throw notFound(`No admin route for ${method} /admin/${seg.join('/')}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const ctx = await requireAdmin(req);
    const url = new URL(req.url);
    const seg = adminSegments(url);
    const res = await route(req.method, seg, req, ctx);

    // Reads are access-logged here; writes self-audit with before/after.
    if (req.method === 'GET') {
      await writeAudit(ctx, { action: `read:/admin/${seg.join('/')}` });
    }
    return res;
  } catch (err) {
    if (err instanceof ProblemError) return problem(err);
    console.error('admin handler error', err);
    // Admin-only surface: surface the actual message so a 500 is diagnosable
    // from the response body, not just the logs.
    const detail = err instanceof Error ? err.message : 'Unexpected error.';
    return problem(new ProblemError(500, 'Internal Server Error', detail));
  }
});
