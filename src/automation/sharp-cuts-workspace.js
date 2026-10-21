import {SHARP_CUTS_BOOKING_URL,SHARP_CUTS_SERVICE_SOURCE,SHARP_CUTS_STAGING_SNAPSHOT} from "./sharp-cuts-campaign.js";

export const SHARP_CUTS_WORKSPACE_ID="sharp-cuts-business-workspace";

const resource=(value)=>Object.freeze(value);

export function buildSharpCutsWorkspaceManifest({projectReady=false,senderConnected=false}={}){
  return Object.freeze({
    version:1,
    id:SHARP_CUTS_WORKSPACE_ID,
    name:"Sharp Cuts",
    mode:"owner_operated_business_workspace",
    projectBoundary:Object.freeze({
      primaryProjectId:"sharp-cuts-web",
      legacyProjectId:"sharp-cuts",
      relationship:"independent",
      legacyContextInjection:false,
      mergeAuthorised:false,
      note:"The historical Sharp Cuts record remains separate. The imported Sharp Cuts Web project is the current operational anchor until an owner-approved archive or migration is completed."
    }),
    knowledgeBase:Object.freeze({
      status:projectReady?"project_scoped_sources_available":"project_import_required",
      writePolicy:"owner_reviewed_verified_facts_only",
      automaticPromotion:false,
      crossProjectInjection:false,
      authoritativeSources:Object.freeze({
        servicesAndPrices:SHARP_CUTS_SERVICE_SOURCE,
        liveBookings:"Fresha",
        publicBookingUrl:SHARP_CUTS_BOOKING_URL,
        customerStaging:Object.freeze({
          projectId:SHARP_CUTS_STAGING_SNAPSHOT.projectId,
          branchId:SHARP_CUTS_STAGING_SNAPSHOT.branchId,
          database:SHARP_CUTS_STAGING_SNAPSHOT.database,
          mode:"encrypted_server_side_with_aggregate_browser_view"
        }),
        website:"hshanbour/sharp-cuts-web"
      })
    }),
    resources:Object.freeze([
      resource({id:"shop-operations",label:"Shop Operations",businessRole:"staff_services_campaigns_and_operational_status",externalStatus:"fresha_remains_live_source",novaStatus:"read_only_command_centre",permissionBoundary:"no_booking_staff_price_or_customer_change_authorised",writesEnabled:false}),
      resource({id:"fresha",label:"Fresha",businessRole:"live_booking_source_of_truth",externalStatus:"owner_account_exists",novaStatus:"bounded_exports_and_read_only_inspection_only",permissionBoundary:"no_general_transactional_api_verified",writesEnabled:false}),
      resource({id:"sharp-cuts-web",label:"Sharp Cuts Web",businessRole:"public_website_and_future_booking_platform",externalStatus:"separate_github_vercel_neon_project",novaStatus:projectReady?"project_onboarding_connected":"project_import_required",permissionBoundary:"discovery_does_not_authorise_execution",writesEnabled:false}),
      resource({id:"customer-staging",label:"Customer staging",businessRole:"migration_and_retention_analysis",externalStatus:"encrypted_isolated_neon_staging",novaStatus:"aggregate_dashboard_ready",permissionBoundary:"identifiable_data_server_side_only",writesEnabled:false}),
      resource({id:"instagram",label:"Instagram @sharpcuts.uk",businessRole:"official_social_profile",externalStatus:"owner_confirmed_meta_asset",novaStatus:"blocked_pending_project_scoped_oauth",permissionBoundary:"current_instagram_token_storage_is_owner_scoped",writesEnabled:false}),
      resource({id:"facebook",label:"Facebook Sharp Cuts Gents Barbers",businessRole:"official_facebook_page",externalStatus:"owner_confirmed_linked_to_instagram",novaStatus:"not_authorised_for_project_scoped_publishing",permissionBoundary:"external_asset_link_is_not_nova_api_permission",writesEnabled:false}),
      resource({id:"tiktok",label:"TikTok · future integration",businessRole:"future_short_form_distribution",externalStatus:"not_connected",novaStatus:"official_authorization_required",permissionBoundary:"no_placeholder_account_or_unsupported_publishing",writesEnabled:false}),
      resource({id:"meta",label:"SHARP CUTS Meta Business Portfolio and Ad Account",businessRole:"asset_and_campaign_management",externalStatus:"owner_confirmed_existing",novaStatus:"readiness_record_only",permissionBoundary:"no_ad_creation_or_spend_authority",writesEnabled:false}),
      resource({id:"email",label:"Sender.net · info@sharpcuts.uk",businessRole:"approval_gated_email_campaigns",externalStatus:senderConnected?"authenticated_provider_probe_passed":"connection_not_verified_in_this_runtime",novaStatus:senderConnected?"draft_preparation_connected":"draft_only",permissionBoundary:"customer_upload_and_send_require_separate_exact_approval",writesEnabled:false}),
      resource({id:"whatsapp",label:"Sharp Cuts WhatsApp Business",businessRole:"manual_customer_contact",externalStatus:"business_app_managed",novaStatus:"manual_app_only",permissionBoundary:"no_paid_api_or_automated_messaging_authorised",writesEnabled:false})
    ]),
    controls:Object.freeze({
      externalWrites:false,
      publishing:false,
      customerMessaging:false,
      bookingChanges:false,
      advertising:false,
      spending:false,
      ownerApprovalRequired:true,
      protectedPersonalAccounts:true
    })
  });
}
