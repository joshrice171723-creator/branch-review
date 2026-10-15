require 'securerandom'
require 'json'

database = ActiveRecord::Base.connection_db_config.database
abort 'Review fixtures require an isolated review database.' unless Rails.env.development? && database.match?(/\Aapply_review_(original|changed|standby)_[0-9a-f]{12}_development\z/)

User.transaction do
  user = User.find_or_create_by!(email_address: 'review-staff@example.invalid') do |record|
    record.password = SecureRandom.hex(32)
    record.active = true
  end
  membership = Development::TestClinic.create!(user)
  practice = membership.practice
  practice.update!(name: 'Intake Review Clinic')
  patient = practice.patients.find_or_create_by!(reference: 'SYN-REVIEW-INTAKE') do |record|
    record.display_name = 'Jordan Review'
  end
  encounter = Clinic::Encounter.find_or_create_by!(practice: practice, patient: patient) do |record|
    record.started_at = Time.current - 15.minutes
    record.status = 'in_progress'
  end
  if ENV['BRANCH_REVIEW_RESET'] == '1'
    Clinic::EncounterIntakeRevision.where(practice: practice, encounter: encounter).delete_all
  end
  unless Clinic::EncounterIntakeRevision.exists?(practice: practice, encounter: encounter)
    answers = { 'visit_reason' => { 'state' => 'answered', 'value' => 'Discuss energy levels and build a sustainable routine.' }, 'goals' => { 'state' => 'answered', 'value' => 'Walk comfortably for thirty minutes.' } }
    questionnaire = Clinic::Care::PrevisitIntake.encode(form_id: 'weight-management-initial-v1', answers: answers,
      text: '', status: 'draft', attested: false, recorder: 'staff', confirmed_chunks: [])
    Clinic::EncounterIntakeRevision.create!(practice: practice, patient: patient, encounter: encounter,
      recorded_by_membership: membership, version_number: 1, status: 'incomplete',
      identity_state: 'confirmed', visit_reason_state: 'confirmed', history_state: 'incomplete', vitals_state: 'not_recorded',
      request_key: 'branch-review-intake-v1', content_digest: Digest::SHA256.hexdigest(questionnaire),
      recorded_at: Time.current, encrypted_questionnaire: questionnaire)
  end
  puts 'BRANCH_REVIEW=' + JSON.generate({ profile: "employee-#{user.id}", portal: 'clinic', practice_id: practice.id,
    patient: 'Jordan Review', path: "/clinic/patients/#{patient.id}/encounters/#{encounter.id}#nurse-workspace" })
end
