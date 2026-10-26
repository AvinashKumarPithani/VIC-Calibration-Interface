from __future__ import annotations

from fastapi.testclient import TestClient

from app import services
from app.core.config import Settings
from app.main import create_app
from app.schemas.inspection import EditableParameterField


def upload_rat(client: TestClient, project_id: str, job_id: str) -> tuple[dict, bytes]:
    source = b"GLOBAL: {}\nBASIN:\n  basin_name: test_basin\n"
    response = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("rat_config.yaml", source, "application/yaml")},
    )
    assert response.status_code == 201
    return response.json(), source


def test_draft_endpoints_are_scoped_and_reject_unapproved_fields(client: TestClient, project_and_job: tuple[str, str]) -> None:
    project_id, job_id = project_and_job
    upload, _ = upload_rat(client, project_id, job_id)
    other_job = client.post(f"/api/projects/{project_id}/jobs", json={"name": "Other job"}).json()
    other_project = client.post("/api/projects", json={"name": "Other"}).json()
    other_project_job = client.post(f"/api/projects/{other_project['id']}/jobs", json={"name": "Other project job"}).json()

    path = f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}/draft"
    assert client.get(path).status_code == 200
    assert client.get(path).json() is None
    assert client.get(f"/api/projects/{project_id}/jobs/{other_job['id']}/uploads/{upload['id']}/draft").status_code == 404
    assert client.get(f"/api/projects/{other_project['id']}/jobs/{other_project_job['id']}/uploads/{upload['id']}/draft").status_code == 404
    rejected = client.put(path, json={
        "expected_revision": None,
        "source_format": "rat_yaml",
        "changes": [{"field_id": "BASIN.basin_name", "value": "changed"}],
    })
    assert rejected.status_code == 422
    assert "read-only" in rejected.json()["detail"]
    inspection = client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}/inspection").json()
    assert inspection["editable_fields"] == []


def test_approved_metadata_can_save_revisioned_overlay_without_changing_source(
    client: TestClient,
    project_and_job: tuple[str, str],
    monkeypatch,
) -> None:
    project_id, job_id = project_and_job
    upload, source = upload_rat(client, project_id, job_id)
    field = EditableParameterField(
        field_id="test:field", label="Test field", data_type="string", current_value="original"
    )
    monkeypatch.setattr(services.parameter_drafts, "approved_fields_for_inspection", lambda _inspection: [field])
    monkeypatch.setattr("app.services.inspection.approved_fields_for_inspection", lambda _inspection: [field])
    path = f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}/draft"
    saved = client.put(path, json={
        "expected_revision": None,
        "source_format": "rat_yaml",
        "changes": [{"field_id": field.field_id, "value": "proposal"}],
    })
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 1
    assert saved.json()["changes"] == [{"field_id": "test:field", "value": "proposal"}]
    assert client.get(path).json()["changes"] == saved.json()["changes"]
    revised = client.put(path, json={
        "expected_revision": 1,
        "source_format": "rat_yaml",
        "changes": [{"field_id": field.field_id, "value": "revised proposal"}],
    })
    assert revised.status_code == 200
    assert revised.json()["revision"] == 2
    assert revised.json()["changes"][0]["value"] == "revised proposal"

    original_inspection = client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}/inspection").json()
    assert original_inspection["representation"]["root"]["entries"][1]["value"]["entries"][0]["value"]["value"] == "test_basin"
    stored_files = list(client.app.state.settings.upload_dir.iterdir())
    assert len(stored_files) == 1
    assert stored_files[0].read_bytes() == source

    stale = client.put(path, json={
        "expected_revision": None,
        "source_format": "rat_yaml",
        "changes": [{"field_id": field.field_id, "value": "another"}],
    })
    assert stale.status_code == 409
    assert client.delete(path).status_code == 204
    assert client.get(path).json() is None


def test_draft_survives_backend_restart_and_is_removed_with_its_source(
    backend_settings: Settings,
    project_and_job: tuple[str, str],
    monkeypatch,
) -> None:
    project_id, job_id = project_and_job
    field = EditableParameterField(field_id="test:field", label="Test field", data_type="string", current_value="original")
    monkeypatch.setattr(services.parameter_drafts, "approved_fields_for_inspection", lambda _inspection: [field])
    monkeypatch.setattr("app.services.inspection.approved_fields_for_inspection", lambda _inspection: [field])

    with TestClient(create_app(backend_settings)) as client:
        upload, _ = upload_rat(client, project_id, job_id)
        path = f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}/draft"
        saved = client.put(path, json={
            "expected_revision": None,
            "source_format": "rat_yaml",
            "changes": [{"field_id": field.field_id, "value": "draft value"}],
        })
        assert saved.status_code == 200
        upload_id = upload["id"]

    with TestClient(create_app(backend_settings)) as restarted:
        path = f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}/draft"
        assert restarted.get(path).json()["changes"][0]["value"] == "draft value"
        assert restarted.delete(f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}").status_code == 204
        assert restarted.get(path).status_code == 404


def test_draft_type_constraints_are_checked_before_persisting(
    client: TestClient,
    project_and_job: tuple[str, str],
    monkeypatch,
) -> None:
    project_id, job_id = project_and_job
    upload, _ = upload_rat(client, project_id, job_id)
    field = EditableParameterField(field_id="test:number", label="Test number", data_type="integer", current_value=4, minimum=1, maximum=6)
    monkeypatch.setattr(services.parameter_drafts, "approved_fields_for_inspection", lambda _inspection: [field])
    path = f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}/draft"
    for value in ("not a number", 7):
        response = client.put(path, json={
            "expected_revision": None,
            "source_format": "rat_yaml",
            "changes": [{"field_id": field.field_id, "value": value}],
        })
        assert response.status_code == 422
    assert client.get(path).json() is None


def test_changed_source_invalidates_its_saved_draft(
    client: TestClient,
    project_and_job: tuple[str, str],
    monkeypatch,
) -> None:
    project_id, job_id = project_and_job
    upload, _ = upload_rat(client, project_id, job_id)
    field = EditableParameterField(field_id="test:field", label="Test field", data_type="string", current_value="original")
    monkeypatch.setattr(services.parameter_drafts, "approved_fields_for_inspection", lambda _inspection: [field])
    monkeypatch.setattr("app.services.inspection.approved_fields_for_inspection", lambda _inspection: [field])
    path = f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}/draft"
    saved = client.put(path, json={
        "expected_revision": None,
        "source_format": "rat_yaml",
        "changes": [{"field_id": field.field_id, "value": "proposal"}],
    })
    assert saved.status_code == 200

    from app.models import Upload
    from sqlalchemy.orm import Session

    with Session(client.app.state.engine) as session:
        record = session.get(Upload, upload["id"])
        assert record is not None
        stored_path = client.app.state.settings.upload_dir / record.storage_filename
    stored_path.write_bytes(b"GLOBAL: {}\nBASIN: {}\n")
    invalidated = client.get(path)
    assert invalidated.status_code == 409
    assert "source upload changed" in invalidated.json()["detail"].lower()
    assert client.get(path).json() is None
