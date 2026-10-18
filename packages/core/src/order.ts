// What a client asks for when it orders a video, and the jobs the rented VM can be given.
import { z } from 'zod';

export const OrderRequestSchema = z.object({
  url: z.string().url().max(2048),
  // Trimmed first, so the limit counts what the director will read.
  brief: z.string().trim().max(200).optional(),
  // Up to 3 more public pages of the same product (an app screen, a pricing page).
  extraUrls: z.array(z.string().url()).max(3).optional(),
  // 'voice' is accepted by the schema but not sold yet: the route answers 400 for it.
  audio: z.enum(['music', 'none', 'voice']).default('music'),
});

export type VmTaskKind = 'capture' | 'keyframes' | 'render' | 'shutdown';
