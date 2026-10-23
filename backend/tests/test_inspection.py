from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.models import Upload
from app.services.inspection import inspect_upload_content


def _fake_upload(filename: str) -> Upload:
    return Upload(
        id="upload-id",
        project_id="project-id",
        job_id="job-id",
        original_filename=filename,
        storage_filename="generated-name",
        file_size=1,
        uploaded_at=datetime.now(timezone.utc),
    )


def test_yaml_preserves_nested_mappings_lists_types_nulls_and_spaced_keys() -> None:
    text = b"""GLOBAL:\n  steps: [1, 2, false]\n  cleaning: false\n  optional: null\nBASIN: {}\nVIC PARAMETERS:\n  'option group':\n    nested: [true, 3.5, null]\n"""
    result = inspect_upload_content(_fake_upload("rat_config.yaml"), text)

    assert result.parse_status == "parsed"
    assert result.detected_format == "rat_yaml"
    assert result.scientific_validity == "not_checked"
    root = result.representation.root
    keys = [entry.key for entry in root.entries]
    assert keys == ["GLOBAL", "BASIN", "VIC PARAMETERS"]
    global_group = root.entries[0].value
    assert [entry.key for entry in global_group.entries] == ["steps", "cleaning", "optional"]
    steps = global_group.entries[0].value
    assert [node.value for node in steps.items] == [1, 2, False]
    assert global_group.entries[2].value.kind == "null"
    spaced_key = root.entries[2].value.entries[0]
    assert spaced_key.key == "option group"
    assert [node.scalar_type for node in spaced_key.value.entries[0].value.items] == ["boolean", "number", "null"]


def test_yaml_rejects_duplicate_keys_without_silently_overwriting() -> None:
    result = inspect_upload_content(_fake_upload("rat_config.yaml"), b"BASIN:\n  basin_id: 1\n  basin_id: 2\n")

    assert result.parse_status == "malformed"
    assert result.parse_errors[0].code == "invalid_yaml"
    assert result.parse_errors[0].line == 3


def test_yaml_secret_fields_are_redacted() -> None:
    result = inspect_upload_content(
        _fake_upload("rat_config.yaml"),
        b"GLOBAL: {}\nBASIN: {}\nCONFIDENTIAL:\n  secrets: /private/location/secrets.ini\nVIC:\n  api_token: do-not-return\n",
    )

    rendered = result.model_dump_json()
    assert "do-not-return" not in rendered
    assert "/private/location/secrets.ini" not in rendered
    assert "secrets.ini" not in rendered
    assert "[REDACTED]" in rendered



def test_nested_secret_key_variations_are_redacted() -> None:
    result = inspect_upload_content(
        _fake_upload("rat_config.yaml"),
        b"GLOBAL: {}\nBASIN: {}\nVIC:\n  nested:\n    client_passphrase: should-not-return\n",
    )

    assert "should-not-return" not in result.model_dump_json()
    assert "[REDACTED]" in result.model_dump_json()

def test_yaml_secret_aliases_do_not_leak_through_other_keys() -> None:
    result = inspect_upload_content(
        _fake_upload("rat_config.yaml"),
        b"GLOBAL: {}\nBASIN: {}\nCONFIDENTIAL:\n  password: &credential private-value\nVIC:\n  copied_value: *credential\n",
    )

    rendered = result.model_dump_json()
    assert "private-value" not in rendered
    assert "[REDACTED]" in rendered


def test_vic_parser_keeps_repeated_options_multitokens_and_comments() -> None:
    result = inspect_upload_content(
        _fake_upload("vic_params.txt"),
        b"# Domain heading\nDOMAIN_TYPE LAT\tlat\nDOMAIN_TYPE MASK mask\nFORCE_TYPE AIR_TEMP temp\nAGGFREQ NDAYS 1\n\n",
    )

    assert result.parse_status == "parsed"
    lines = result.representation.lines
    entries = [line for line in lines if line.kind == "entry"]
    assert [line.option for line in entries] == ["DOMAIN_TYPE", "DOMAIN_TYPE", "FORCE_TYPE", "AGGFREQ"]
    assert entries[0].values == ["LAT", "lat"]
    assert entries[0].value_text == "LAT\tlat"
    assert lines[0].kind == "comment" and lines[0].raw == "# Domain heading"
    assert lines[-1].kind == "blank"


def test_routing_parser_preserves_heading_boundaries_and_raw_records() -> None:
    result = inspect_upload_content(
        _fake_upload("route_param.txt"),
        b"# FLOW DIRECTION FILE\nflow.asc\n# VELOCITY FILE\n.false.\n1.5\n# START and END\n2016 01 03\n2022 07 01\n",
    )

    assert result.parse_status == "parsed"
    records = result.representation.records
    assert [record.heading for record in records] == ["FLOW DIRECTION FILE", "VELOCITY FILE", "START and END"]
    assert records[0].heading_raw == "# FLOW DIRECTION FILE"
    assert records[0].heading_line_number == 1
    assert [line.raw for line in records[1].lines] == [".false.", "1.5"]
    assert records[2].lines[0].line_number == 7
    assert records[2].lines[1].raw == "2022 07 01"


def test_unit_hydrograph_valid_and_malformed_rows() -> None:
    valid = inspect_upload_content(_fake_upload("uh.txt"), b"0   0.01\n1 0.24\n")
    malformed = inspect_upload_content(_fake_upload("uh.txt"), b"0 0.01\n1 nope\n2 0.3 extra\n")

    assert valid.parse_status == "parsed"
    assert valid.representation.rows[0].index_token == "0"
    assert valid.representation.rows[0].value_token == "0.01"
    assert valid.representation.rows[1].value == 0.24
    assert malformed.parse_status == "malformed"
    assert [error.line for error in malformed.parse_errors] == [2, 3]


def test_valid_yaml_with_recognized_rat_filename_but_unrelated_content_is_unsupported() -> None:
    result = inspect_upload_content(_fake_upload("rat_config.yaml"), b"ordinary_document: [one, two]\n")

    assert result.parse_status == "unsupported"
    assert result.detected_format == "unknown"
    assert result.representation is None


def test_rat_yaml_is_detected_from_structure_even_when_renamed() -> None:
    result = inspect_upload_content(_fake_upload("renamed.yaml"), b"GLOBAL: {}\nBASIN: {}\nVIC: {}\n")

    assert result.parse_status == "parsed"
    assert result.detected_format == "rat_yaml"



def test_yaml_matching_multiple_supported_signatures_is_unsupported() -> None:
    result = inspect_upload_content(
        _fake_upload("configuration.yaml"),
        b"GLOBAL: {}\nBASIN: {}\nMetSim: {}\nchunks: {}\n",
    )

    assert result.parse_status == "unsupported"
    assert result.detected_format == "unknown"
    assert result.parse_errors[0].code == "ambiguous_format"

def test_vic_option_without_value_tokens_is_malformed() -> None:
    result = inspect_upload_content(_fake_upload("vic_params.txt"), b"OPTION\n")

    assert result.parse_status == "malformed"
    assert result.parse_errors[0].code == "missing_vic_values"
    assert result.parse_errors[0].line == 1



def test_routing_heading_without_positional_values_is_malformed() -> None:
    result = inspect_upload_content(_fake_upload("route_param.txt"), b"# heading only\n")

    assert result.parse_status == "malformed"
    assert result.parse_errors[0].code == "routing_records_not_found"

def test_headerless_routing_and_comment_only_vic_are_malformed() -> None:
    routing = inspect_upload_content(_fake_upload("route_param.txt"), b"only positional values\n")
    vic = inspect_upload_content(_fake_upload("vic_params.txt"), b"# comments only\n\n")

    assert routing.parse_status == "malformed"
    assert routing.parse_errors[0].code == "routing_records_not_found"
    assert vic.parse_status == "malformed"
    assert vic.parse_errors[0].code == "no_vic_entries"


def test_invalid_yaml_and_unsupported_format_are_reported_without_content() -> None:
    malformed = inspect_upload_content(_fake_upload("rat_config.yaml"), b"GLOBAL: [unterminated\n")
    unsupported = inspect_upload_content(_fake_upload("readme.csv"), b"private,content\n")

    assert malformed.parse_status == "malformed"
    assert malformed.parse_errors[0].line is not None
    assert "unterminated" not in malformed.parse_errors[0].message
    assert unsupported.parse_status == "unsupported"
    assert unsupported.detected_format == "unknown"


def test_inspection_endpoint_preserves_original_uploaded_bytes(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    source = b"MetSim:\n  time_step: 360\nchunks:\n  lat: 30\n"
    response, original = _upload_for_inspection(client, project_id, job_id, "params.yaml", source)

    assert response.status_code == 200
    data = response.json()
    assert data["detected_format"] == "metsim_yaml"
    assert data["parse_status"] == "parsed"
    assert data["rat_compatibility"] == "not_checked"
    assert data["dependency_availability"] == "not_checked"
    assert data["scientific_validity"] == "not_checked"
    stored = list(backend_settings.upload_dir.iterdir())
    assert len(stored) == 1
    assert stored[0].read_bytes() == original
    assert "storage_filename" not in response.text
    assert str(backend_settings.upload_dir) not in response.text


def _upload_for_inspection(client: TestClient, project_id: str, job_id: str, filename: str, content: bytes):
    response = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": (filename, content, "application/octet-stream")},
    )
    assert response.status_code == 201
    uploaded = response.json()
    inspection = client.get(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads/{uploaded['id']}/inspection"
    )
    return inspection, content


def test_inspection_endpoint_enforces_project_job_upload_ownership(
    client: TestClient,
    project_and_job: tuple[str, str],
) -> None:
    project_id, job_id = project_and_job
    other_project = client.post("/api/projects", json={"name": "Other"}).json()
    other_job = client.post(
        f"/api/projects/{other_project['id']}/jobs", json={"name": "Other job"}
    ).json()
    uploaded = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("rat_config.yaml", b"GLOBAL: {}\n", "text/yaml")},
    ).json()

    wrong_job = client.get(
        f"/api/projects/{project_id}/jobs/{other_job['id']}/uploads/{uploaded['id']}/inspection"
    )
    wrong_project = client.get(
        f"/api/projects/{other_project['id']}/jobs/{other_job['id']}/uploads/{uploaded['id']}/inspection"
    )
    missing_project = client.get("/api/projects/missing/jobs/missing/uploads/missing/inspection")
    missing_job = client.get(f"/api/projects/{project_id}/jobs/missing/uploads/missing/inspection")
    missing_upload = client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads/missing/inspection")

    assert [response.status_code for response in (wrong_job, wrong_project, missing_project, missing_job, missing_upload)] == [404] * 5


def test_inspection_reports_missing_physical_upload(client: TestClient, project_and_job: tuple[str, str]) -> None:
    project_id, job_id = project_and_job
    uploaded = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("uh.txt", b"0 0.2\n", "text/plain")},
    ).json()
    session = client.app.state.session_factory()
    try:
        record = session.get(Upload, uploaded["id"])
        assert record is not None
        stored = record.storage_filename
    finally:
        session.close()
    (client.app.state.settings.upload_dir / stored).unlink()

    response = client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads/{uploaded['id']}/inspection")

    assert response.status_code == 404
    assert response.json()["detail"] == "Uploaded file content is unavailable."


@pytest.mark.parametrize(
    ("relative_path", "filename"),
    [
        ("metsim/params.yaml", "params.yaml"),
        ("vic/vic_params.txt", "vic_params.txt"),
        ("routing/route_param.txt", "route_param.txt"),
        ("routing/uh.txt", "uh.txt"),
        ("rat_config.yaml", "rat_config.yaml"),
        ("rat_config_template.yml", "rat_config_template.yml"),
    ],
)
def test_downloaded_reference_files_are_inspectable_when_present(
    client: TestClient,
    project_and_job: tuple[str, str],
    relative_path: str,
    filename: str,
) -> None:
    reference_root = Path(__file__).resolve().parents[2] / "RAT Workflow Files" / "params"
    reference = reference_root / relative_path
    if not reference.is_file():
        pytest.skip("Optional local RAT reference file is not present in this checkout.")
    # This reads only the named configuration/parameter file; it never opens secrets.ini.
    source = reference.read_bytes()
    inspected = inspect_upload_content(_fake_upload(filename), source)
    assert inspected.parse_status == "parsed"
    if filename == "rat_config.yaml":
        assert "secrets.ini" not in inspected.model_dump_json()
