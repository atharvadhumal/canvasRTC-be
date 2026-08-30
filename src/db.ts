import 'dotenv/config'
import * as PrismaClientModule from '@prisma/client'

const { PrismaClient } = PrismaClientModule as any
import { PrismaNeon } from '@prisma/adapter-neon'

const adapter = new PrismaNeon({
  connectionString: process.env.DATABASE_URL!,
})

export const prisma = new PrismaClient({ adapter })