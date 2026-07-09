import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "react-toastify";
import * as XLSX from "xlsx";
import { Button, Input, Table, Upload } from "antd";
import type { TableColumnsType } from "antd";
import type { User, UserCreate } from "../types";
import { teamsOptions } from "../types";
import { useLoading } from "../hook/LoadingContext";
import { listUsers } from "../api/users";
import { CreateUserModal } from "./Modal/CreateUserModal";
import { createUserBatch, deleteUser, searchUser } from "../api/users";
import { ConfirmModal } from "./Modal/ConfirmModal";
import {
  PlusIcon,
  SearchIcon,
  UploadIcon,
  TrashIcon,
  EditIcon,
} from "./icons";

export const UserMainScreen = () => {
  const [users, setUsers] = useState<User[]>([]);
  const { startLoading, endLoading } = useLoading();
  const [searchData, setSearchData] = useState("");
  const [isOpenCreateUserModal, setIsOpenCreateUserModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [isSelectedAll, setIsSelectedAll] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserCreate>({
    employee_code: "",
    name: "",
    team: "",
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isEdit, setIsEdit] = useState(false);

  const [deleteUserData, setDeleteUserData] = useState<User | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  const loadUsers = async () => {
    try {
      const userList = await listUsers();
      setUsers(userList.map((user) => ({ ...user, selected: false })));
    } catch (err) {
      console.error(err);
    }
  };

  const loadUsersCallback = useCallback(async () => {
    startLoading();
    await loadUsers();
    setTimeout(() => {
      endLoading();
    }, 1000);
  }, [users.length]);

  useEffect(() => {
    if (users.length === 0) {
      loadUsersCallback();
    }
  }, [loadUsersCallback]);

  useEffect(() => {
    setUsers((prevUsers) =>
      prevUsers.map((user) => ({ ...user, selected: isSelectedAll })),
    );
  }, [isSelectedAll]);

  const validateImportedUsers = (importedUsers: User[]): User[] | null => {
    for (let i = 0; i < importedUsers.length; i++) {
      const user = importedUsers[i];
      const emptyFields: string[] = [];
      const invalidTeams: string[] = [];

      if (!user.employee_code?.trim()) emptyFields.push("employee_code");
      if (!user.name?.trim()) emptyFields.push("name");
      if (!user.team?.trim()) emptyFields.push("team");
      if (
        user.team &&
        !teamsOptions.some((team) => team.team_id === user.team)
      ) {
        invalidTeams.push(user.team);
      }

      if (emptyFields.length > 0) {
        toast.error(`Row ${i + 1}: missing [${emptyFields.join(", ")}]`, {
          position: "top-right",
        });
        return null;
      }
      if (invalidTeams.length > 0) {
        toast.error(`Row ${i + 1}: invalid team [${invalidTeams.join(", ")}]`, {
          position: "top-right",
        });
        return null;
      }
    }
    return importedUsers;
  };

  const handleImport = async (file: File) => {
    setImportFile(file);

    // 1. Read the Excel file as bytes
    try {
      startLoading();
      const buffer = await file.arrayBuffer();

      // 2. Parse the workbook and grab the first sheet
      const workbook = XLSX.read(buffer);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];

      // 3. Convert the sheet's rows into objects keyed by the header row
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
      // 4. Map each row to your User shape (adjust header names to match your file)
      const importedUsers: User[] = rows.map((row) => ({
        employee_code: String(row["employee_code"] ?? ""),
        name: row["name"] != null ? String(row["name"]) : null,
        team: row["team"] != null ? String(row["team"]) : null,
        selected: false,
      }));

      const validatedUsers = validateImportedUsers(importedUsers);
      if (validatedUsers) {
        const response = await createUserBatch(validatedUsers);
        if (response) {
          toast.success("Users imported successfully!", {
            position: "top-right",
          });
          // Refresh the user list after import
        }
      }
    } catch (error) {
      console.error("Error reading the Excel file:", error);
      toast.error("Failed to import users: " + error, {
        position: "top-right",
      });
    } finally {
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadUsers();
      setTimeout(() => {
        endLoading();
      }, 1000);
    }
  };

  const handleDeleteSelected = async () => {
    const selectedUsers = users.filter((user) => user.selected);
    try {
      startLoading();
      await Promise.all(
        selectedUsers.map((user) => deleteUser(user.employee_code)),
      );
      setIsSelectedAll(false);
    } catch (error) {
      console.error("Error deleting users:", error);
      toast.error("Failed to delete users: " + error, {
        position: "top-right",
      });
    } finally {
      await loadUsersCallback();
      setTimeout(() => {
        endLoading();
      }, 1000);
    }
  };

  const handleSearch = async () => {
    try {
      startLoading();
      const searchedList = await searchUser(searchData);
      if (searchedList.length !== 0) {
        setUsers(searchedList);
      } else {
        toast.info("No users match the search criteria.", {
          position: "top-right",
        });
        setUsers([]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setTimeout(() => {
        endLoading();
      }, 1000);
    }
  };

  const handleDeleteUser = async (employeeCode: string) => {
    try {
      setIsDeleteModalOpen(false);
      startLoading();
      await deleteUser(employeeCode);
    } catch (error) {
      console.error("Error deleting user:", error);
      toast.error("Failed to delete user: " + error, {
        position: "top-right",
      });
    } finally {
      await loadUsers();
      setTimeout(() => {
        endLoading();
      }, 1000);
    }
  };

  const columns: TableColumnsType<User> = [
    {
      title: "No.",
      key: "index",
      width: 60,
      render: (_, __, index) => index + 1,
    },
    { title: "Employee Code", dataIndex: "employee_code", key: "employee_code" },
    {
      title: "Name",
      dataIndex: "name",
      key: "name",
      render: (name) =>
        name?.trim() ? (
          <span style={{ fontWeight: 600 }}>{name}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      title: "Team",
      dataIndex: "team",
      key: "team",
      render: (team) =>
        team?.trim() ? (
          <span className="pill pill-accent">{team}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      title: "",
      key: "options",
      width: 100,
      render: (_, user) => (
        <div className="flex gap-1">
          <Button
            type="text"
            icon={<EditIcon size={18} />}
            onClick={() => {
              setSelectedUser(user);
              setIsEdit(true);
              setIsOpenCreateUserModal(true);
            }}
          />
          <Button
            type="text"
            danger
            icon={<TrashIcon size={18} />}
            onClick={() => {
              setDeleteUserData(user);
              setIsDeleteModalOpen(true);
            }}
          />
        </div>
      ),
    },
  ];

  const selectedCount = users.filter((u) => u.selected).length;

  return (
    <>
      <div className="screen-toolbar">
        <form
          className="screen-search"
          onSubmit={(e) => {
            e.preventDefault();
            handleSearch();
          }}
        >
          <Input
            name="searchData"
            prefix={<SearchIcon size={16} />}
            allowClear
            style={{ width: 280 }}
            placeholder="Search users…"
            value={searchData}
            onChange={(e) => setSearchData(e.target.value)}
          />
          <Button type="primary" htmlType="submit">
            Search
          </Button>
        </form>
        <div className="toolbar-actions">
          <Upload
            accept=".xlsx,.xls"
            showUploadList={false}
            beforeUpload={(file) => {
              handleImport(file);
              return false;
            }}
          >
            <Button icon={<UploadIcon size={16} />}>
              {importFile ? importFile.name : "Import"}
            </Button>
          </Upload>
          <Button
            danger
            icon={<TrashIcon size={16} />}
            disabled={selectedCount === 0}
            onClick={handleDeleteSelected}
          >
            Delete{selectedCount > 0 ? ` (${selectedCount})` : ""}
          </Button>
          <Button
            type="primary"
            icon={<PlusIcon size={16} />}
            onClick={() => {
              setIsEdit(false);
              setSelectedUser({ employee_code: "", name: "", team: "" });
              setIsOpenCreateUserModal(true);
            }}
          >
            Add User
          </Button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Employee directory</span>
          <span className="panel-count">{users.length} users</span>
        </div>
        <div className="table-wrap">
          <Table<User>
            rowKey="employee_code"
            dataSource={users}
            columns={columns}
            pagination={false}
            scroll={{ x: "max-content" }}
            rowSelection={{
              selectedRowKeys: users
                .filter((user) => user.selected)
                .map((user) => user.employee_code),
              onSelectAll: (selected) => {
                setIsSelectedAll(selected);
              },
              onSelect: (record, selected) => {
                setUsers((prevUsers) =>
                  prevUsers.map((u) =>
                    u.employee_code === record.employee_code
                      ? { ...u, selected }
                      : u,
                  ),
                );
              },
            }}
          />
        </div>
      </div>
      {isOpenCreateUserModal && (
        <CreateUserModal
          onClose={() => {
            setIsOpenCreateUserModal(false);
            loadUsersCallback();
          }}
          isEdit={isEdit}
          selectedUser={selectedUser}
        />
      )}
      {isDeleteModalOpen && (
        <ConfirmModal
          message="Are you sure you want to delete this user?"
          onConfirm={() => {
            if (deleteUserData) {
              handleDeleteUser(deleteUserData.employee_code);
            }
          }}
          onCancel={() => {
            setIsDeleteModalOpen(false);
          }}
        />
      )}
    </>
  );
};
