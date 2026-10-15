require 'json'
database = ActiveRecord::Base.connection_db_config.database
abort 'QA review fixtures require an isolated review database.' unless Rails.env.development? && database.match?(/\Aapply_review_(original|changed)_[0-9a-f]{12}_development\z/)
revision = ENV.fetch('BRANCH_REVIEW_REVISION')
abort 'Invalid review revision.' unless revision.match?(/\A[0-9a-f]{40}\z/) && database.include?(revision[0,12])

# Reproduce persisted post-import state; these are synthetic projection fixtures, not signed live evidence.
Qa::Snapshot.transaction do
  now = Time.current.iso8601
  coverage = (1..116).map do |number|
    { 'id' => format('WF-%03d', number), 'status' => 'untested', 'result' => 'untested',
      'historical' => true, 'revision' => revision, 'agent' => 'Synthetic import',
      'last_attempted_at' => now, 'evidence' => 'Branch Review synthetic historical import' }
  end
  Qa::Snapshot.put(Qa::OfficeQa::KEY, { 'source_label' => 'Branch Review synthetic ledger import',
    'coverage' => coverage, 'defects' => [], 'batches' => [], 'imported_at' => now, 'pointer' => 'WF-011' })
  { 'WF-011' => 'fail', 'WF-012' => 'pass', 'WF-013' => 'fail' }.each do |id, verdict|
    pin = id == 'WF-013' ? '0' * 40 : revision
    Qa::Snapshot.put("#{Qa::MuseWrites::WORKFLOW_SNAPSHOT}#{id}", {
      'status' => verdict, 'build_pin' => pin,
      'submission_build_observation' => { 'revision' => pin, 'version' => 'review-fixture', 'dirty' => false },
      'verdict' => { 'workflow_id' => id, 'verdict' => verdict, 'recorded_at' => now,
        'metadata_unavailable' => false, 'mixed_build' => false,
        'evidence' => [{ 'kind' => 'note', 'text' => 'Synthetic projection fixture: saved result before a later historical import.' }] }
    })
  end
end
puts 'BRANCH_REVIEW=' + JSON.generate({ public: true, path: '/qa?view=coverage', label: 'QA workflow coverage' })
