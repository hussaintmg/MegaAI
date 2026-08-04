import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { goalsCollection, parseGoalId } from '@/lib/goals';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const objectId = parseGoalId(id);
  if (!objectId) return NextResponse.json({ error: 'invalid goal id' }, { status: 400 });
  const goals = await goalsCollection();
  const goal = await goals.findOne({ _id: objectId });
  if (!goal) return NextResponse.json({ error: 'goal not found' }, { status: 404 });
  return NextResponse.json({ goal });
}
