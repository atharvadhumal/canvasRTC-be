import { Router, type Response } from 'express';
import crypto from 'crypto';
import {prisma} from '../db.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

// 1. GET ALL ROOMS (With Search, Filter, and Category support)
router.get('/', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { filter, search, category } = req.query;
    const whereClause: any = {};

    // Search query
    if (search && typeof search === 'string') {
      whereClause.title = { contains: search, mode: 'insensitive' };
    }

    // Tab Filters
    if (filter === 'owned') {
      whereClause.ownerId = userId;
    } else if (filter === 'joined') {
      whereClause.members = { some: { userId } };
    } else {
      whereClause.OR = [
        { ownerId: userId },
        { members: { some: { userId } } },
      ];
    }

    const rooms = await prisma.room.findMany({
      where: whereClause,
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        members: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({ rooms });
  } catch (error) {
    console.error('Fetch rooms error:', error);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// 2. CREATE ROOM
router.post('/', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { title } = req.body;
    const roomCode = `room-${crypto.randomBytes(3).toString('hex')}`;

    const room = await prisma.room.create({
      data: {
        code: roomCode,
        title: title?.trim() || 'Untitled Board',
        ownerId: userId,
        board: {
          create: {
            canvasData: [],
          },
        },
        members: userId
          ? {
              create: {
                userId,
                role: 'HOST',
              },
            }
          : undefined,
      },
      include: {
        board: true,
        members: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
    });

    res.status(201).json({ room });
  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// 3. UPDATE ROOM TITLE
router.patch('/:roomId', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { roomId } = req.params;
    const { title } = req.body;

    const existingRoom = await prisma.room.findUnique({ where: { id: roomId } });
    if (!existingRoom || existingRoom.ownerId !== userId) {
      res.status(403).json({ error: 'You do not have permission to edit this room' });
      return;
    }

    const updatedRoom = await prisma.room.update({
      where: { id: roomId },
      data: { title: title?.trim() },
    });

    res.json({ room: updatedRoom });
  } catch (error) {
    console.error('Update room error:', error);
    res.status(500).json({ error: 'Failed to update room' });
  }
});

// 4. DELETE ROOM
router.delete('/:roomId', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { roomId } = req.params;

    const existingRoom = await prisma.room.findUnique({ where: { id: roomId } });
    if (!existingRoom || existingRoom.ownerId !== userId) {
      res.status(403).json({ error: 'You do not have permission to delete this room' });
      return;
    }

    await prisma.room.delete({ where: { id: roomId } });
    res.json({ message: 'Room deleted successfully' });
  } catch (error) {
    console.error('Delete room error:', error);
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

export default router;