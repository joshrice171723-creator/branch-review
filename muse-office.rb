# Runs through the existing publisher SSH connection, using the bound owner principal.
begin
  config = Qa::OfficeActors.configuration
  user = User.find(Qa::OfficeActorPolicy.positive_id(config["QA_OFFICE_JOSH_USER_ID"]))
  principal = Qa::OfficeWork.identity(user, nil)
  raise "Publisher owner binding unavailable" unless principal[:name] == "josh"
  if input.fetch("action") == "preflight"
    result = { ready: true, actor: principal[:name] }
  elsif input["action"] == "submit"
    task = input.fetch("task")
    raise "Invalid publish assignment" unless task["kind"] == "coordination" && task["recipient"] == "muse" && task["assigned_actor"] == "muse" && task["request_key"].to_s.match?(/\Abranch-review-publish-[a-f0-9]{40}\z/)
    revision = Qa::Workspace.reported_revision(task["revision"])
    build = Qa::Workspace.build
    raise "The live build differs from the assignment" unless revision && revision == build["revision"] && !build["dirty"]
    receipt = Qa::OfficeWork.create(user: user, token: nil, input: task, revision: revision)
    result = receipt.slice("id", "request_key", "revision", "status", "office_status")
  else
    raise "Unsupported publisher action"
  end
  puts "BRANCH_REVIEW_MUSE_RECEIPT=" + JSON.generate(result)
rescue StandardError => error
  warn "Muse Office assignment failed: #{error.class.name}"
  exit 1
end
