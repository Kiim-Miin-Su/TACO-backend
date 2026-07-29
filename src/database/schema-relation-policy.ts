export type LogicalRelationPolicy = {
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
  kind: 'logical' | 'polymorphic';
  reason: string;
};

/**
 * DBML relationships that intentionally are not physical PostgreSQL foreign keys.
 * Keep this list narrow: every entry must explain the lifecycle owner that protects it.
 */
const userReference = (
  sourceTable: string,
  sourceColumn: string,
  reason: string,
): LogicalRelationPolicy => ({
  sourceTable,
  sourceColumns: [sourceColumn],
  targetTable: 'users',
  targetColumns: ['id'],
  kind: 'logical',
  reason,
});

const SOFT_DELETE_ACTOR_REASON =
  'Soft-delete actor snapshot. The numeric actor id is preserved when a sudo hard-delete removes the user.';

export const LOGICAL_RELATION_POLICIES: LogicalRelationPolicy[] = [
  userReference('users', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('countries', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('parents', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('students', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('parent_student_relations', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('subjects', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('courses', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('roadmaps', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('roadmap_courses', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('counsel_forms', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('counsel_rounds', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('payments', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('class_session_series', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('attendance', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('rooms', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('instructor_contracts', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('expenses', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('transactions', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('academy_events', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('session_reports', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference('report_templates', 'deleted_by', SOFT_DELETE_ACTOR_REASON),
  userReference(
    'students',
    'mentor_id',
    'Reserved mentor feature column. No write command exists until the owner promotes or drops the feature.',
  ),
];
