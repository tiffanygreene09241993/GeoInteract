import { relations } from 'drizzle-orm';
import {
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const geofenceEvents = pgTable('geofence_events', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  tripId: text('trip_id').notNull(),
  geofenceId: text('geofence_id').notNull(),
  geofenceLabel: text('geofence_label').notNull(),
  stopId: text('stop_id'),
  eventType: text('event_type').notNull(),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  distanceMeters: doublePrecision('distance_meters'),
  dwellDurationSeconds: integer('dwell_duration_seconds'),
  triggeredAt: timestamp('triggered_at').defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  geofenceEvents: many(geofenceEvents),
}));

export const geofenceEventsRelations = relations(geofenceEvents, ({ one }) => ({
  user: one(users, {
    fields: [geofenceEvents.userId],
    references: [users.id],
  }),
}));
