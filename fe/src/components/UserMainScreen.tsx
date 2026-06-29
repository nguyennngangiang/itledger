import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "react-toastify";
import * as XLSX from "xlsx";
import type { User, UserCreate } from "../types";
import { teamsOptions } from "../types";
import { useLoading } from "../hook/LoadingContext";
import { listUsers } from "../api/users";
import CustomButton from "./CustomButton";
import { CreateUserModal } from "./Modal/CreateUserModal";
import { createUserBatch, deleteUser, searchUser } from "../api/users";
import { ConfirmModal } from "./Modal/ConfirmModal";

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

  return (
    <>
      <div className="menu-title">User List</div>
      <div className="p-3 flex place-content-between ">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSearch();
          }}
        >
          <input
            name="searchData"
            type="text"
            className="text-[16px] p-1 mr-2 "
            placeholder="Search users..."
            value={searchData}
            onChange={(e) => setSearchData(e.target.value)}
          />
          <CustomButton type="submit">Search</CustomButton>
        </form>
        <div>
          <CustomButton
            className="mr-1"
            // color="bg-emerald-500"
            hoverColor="hover:bg-emerald-600"
            onClick={() => setIsOpenCreateUserModal(true)}
          >
            + Create User
          </CustomButton>
          <label className="ml-1 inline-block cursor-pointer rounded-md px-4 py-2 text-white transition-colors duration-200 hover:bg-green-600">
            {importFile ? "Last import file: " + importFile.name : "Import"}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleImport(file);
              }}
            />
          </label>
          <CustomButton
            className="ml-2"
            hoverColor="hover:bg-red-600"
            onClick={handleDeleteSelected}
          >
            Deleted
          </CustomButton>
        </div>
      </div>

      <div>
        <hr className="mx-2" />
        <br />
        <div className="device-table-container">
          <table className="device-table">
            <thead>
              <tr>
                <th>
                  <input
                    className="cursor-pointer scale-150"
                    type="checkbox"
                    name="checkAllUsers"
                    checked={isSelectedAll}
                    onChange={() => {
                      setIsSelectedAll((oldState) => !oldState);
                    }}
                  />
                </th>
                <th>No.</th>
                <th>Employee Code</th>
                <th>Name</th>
                <th>Team</th>
                <th style={{ width: "5vw" }}>Options</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                return (
                  <tr key={user.employee_code}>
                    <td className="text-center">
                      <input
                        className="cursor-pointer scale-150"
                        type="checkbox"
                        name={`check_${user.employee_code}`}
                        checked={user.selected || false}
                        onChange={(e) => {
                          const isChecked = e.target.checked;
                          setUsers((prevUsers) =>
                            prevUsers.map((u) =>
                              u.employee_code === user.employee_code
                                ? { ...u, selected: isChecked }
                                : u,
                            ),
                          );
                        }}
                      />
                    </td>
                    <td className="text-center">{users.indexOf(user) + 1}</td>
                    <td>{user.employee_code}</td>
                    <td>{user.name}</td>
                    <td>{user.team}</td>
                    <td className="flex gap-2">
                      <CustomButton
                        hoverColor="hover:bg-orange-500"
                        onClick={() => {
                          setSelectedUser(user);
                          setIsEdit(true);
                          setIsOpenCreateUserModal(true);
                        }}
                      >
                        Edit
                      </CustomButton>
                      <CustomButton
                        hoverColor="hover:bg-red-700"
                        onClick={() => {
                          setDeleteUserData(user);
                          setIsDeleteModalOpen(true);
                        }}
                      >
                        Delete
                      </CustomButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
