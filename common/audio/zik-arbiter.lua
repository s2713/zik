-- zik-arbiter.lua — WirePlumber 0.4.x single-arbiter audio policy.
--
-- Reads the PipeWire metadata key "active.user" from the "zik" metadata
-- object.  Any stream node whose "zik.user" property does not match the
-- active user is muted via the Props spa parameter.
--
-- The backend signals user switches by calling:
--   pw-metadata -n zik 0 active.user <username>
--
-- NOTE: This script relies on the WirePlumber 0.4.x Lua API (ObjectManager,
-- WpSpaPod, node:set_param).  Validate against the installed wireplumber
-- package version before shipping a production image.

-- Metadata namespace published by the backend.
local METADATA_NAME = "zik"
local METADATA_KEY  = "active.user"

-- Currently active user (nil = mute all zik-tagged streams).
local active_user = nil

-- ---- helpers ----------------------------------------------------------------

-- Build a Props spa pod that sets the mute flag.
local function make_mute_pod(muted)
  return WpSpaPod.new_object(
    "Spa:Pod:Object:Param:Props", "Props",
    "mute", "b", muted
  )
end

-- Apply mute policy to a single node based on its zik.user property.
local function apply_to_node(node)
  local owner = node.properties["zik.user"]
  if owner == nil then return end  -- untagged node — leave alone
  local should_mute = (active_user == nil) or (owner ~= active_user)
  node:set_param("Props", make_mute_pod(should_mute))
end

-- Apply policy to every currently known stream node.
local function apply_policy(om)
  om:iterate():forEach(apply_to_node)
end

-- ---- object managers --------------------------------------------------------

-- Watch output stream nodes that carry a zik.user tag.
local streams_om = ObjectManager {
  Interest {
    type = "node",
    Constraint { "media.class", "matches", "Stream/Output/Audio" },
    Constraint { "zik.user",    "is-present" },
  },
}

-- Watch the zik metadata object.
local metadata_om = ObjectManager {
  Interest {
    type = "metadata",
    Constraint { "metadata.name", "=", METADATA_NAME },
  },
}

-- ---- event wiring -----------------------------------------------------------

-- When a new tagged stream connects, apply the current policy immediately.
streams_om:connect("object-added", function(om, node)
  apply_to_node(node)
end)

-- When the active.user metadata key changes, re-evaluate all streams.
metadata_om:connect("object-added", function(_, metadata)
  metadata:connect("changed", function(_, _subj, key, _type, value)
    if key ~= METADATA_KEY then return end
    active_user = (value ~= "" and value ~= nil) and value or nil
    apply_policy(streams_om)
  end)

  -- Seed active_user from any value already set in the metadata object.
  local existing = metadata:find(0, METADATA_KEY)
  if existing ~= nil and existing ~= "" then
    active_user = existing
    apply_policy(streams_om)
  end
end)

-- Activate both managers once the WirePlumber core is connected.
Core:connect("connected", function()
  streams_om:activate()
  metadata_om:activate()
end)
